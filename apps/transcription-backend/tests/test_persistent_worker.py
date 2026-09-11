import asyncio
import io
import json
import sys
from contextlib import nullcontext
from types import ModuleType
from unittest.mock import Mock

import pytest

from transcription.cosyvoice_worker import synthesize
from transcription.persistent_worker import PersistentWorker
from transcription.processes import WorkerFailure


def test_requests_reuse_one_process_and_close_it(tmp_path):
    script = tmp_path / "worker.py"
    script.write_text("""import json, os, sys
for line in sys.stdin:
    config = json.loads(line)
    print(json.dumps({"kind":"synthesized", "id":config["id"], "pid":os.getpid()}), flush=True)
    print('{"kind":"done"}', flush=True)
""")

    async def check():
        worker = PersistentWorker([sys.executable, str(script)])
        events = []
        await asyncio.gather(*(worker.run("tts", {"id": n}, events.append) for n in range(3)))
        clips = [e for e in events if e["kind"] == "synthesized"]
        assert [e["id"] for e in clips] == [0, 1, 2]
        assert len({e["pid"] for e in clips}) == 1
        await worker.close()
        assert worker.process.returncode is not None

    asyncio.run(check())


def test_cancellation_terminates_model_process(tmp_path):
    script = tmp_path / "worker.py"
    script.write_text("import time\ntime.sleep(60)\n")

    async def check():
        worker = PersistentWorker([sys.executable, str(script)])
        task = asyncio.create_task(worker.run("tts", {}, lambda _: None))
        while worker.process is None:
            await asyncio.sleep(0.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert worker.process.returncode is not None
        assert worker.closed

    asyncio.run(check())


def test_dead_worker_is_reported_without_hanging():
    async def check():
        worker = PersistentWorker([sys.executable, "-c", "pass"])
        with pytest.raises(WorkerFailure, match="worker_unexpected_eof"):
            await asyncio.wait_for(worker.run("tts", {}, lambda _: None), 5)
        assert worker.closed

    asyncio.run(check())


def test_cosyvoice_loads_model_once_for_multiple_requests(monkeypatch, tmp_path):
    class Samples:
        def detach(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self

        def reshape(self, _):
            return [0.0] * 24000

    model = Mock(sample_rate=24000)
    model.inference_cross_lingual.side_effect = lambda *a, **kw: [{"tts_speech": Samples()}]
    constructor = Mock(return_value=model)
    cosy = ModuleType("cosyvoice.cli.cosyvoice")
    cosy.CosyVoice3 = constructor
    torch = ModuleType("torch")
    torch.inference_mode = nullcontext
    torch.cat = lambda *a, **kw: Samples()
    sf = ModuleType("soundfile")
    sf.write = Mock()
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "soundfile", sf)
    monkeypatch.setitem(sys.modules, "cosyvoice.cli.cosyvoice", cosy)
    monkeypatch.setattr("subprocess.check_output", lambda *a, **kw: "GPU-test, Test GPU\n")
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "test")
    config = {
        "tts_gpu": "Test GPU",
        "cosyvoice_source_path": str(tmp_path),
        "cosyvoice_model_path": str(tmp_path),
        "directory": str(tmp_path),
        "phrases": [{"id": "a", "text": "Привет", "voice": "demo"}],
    }
    models = []
    events = io.StringIO()
    synthesize(config, events, models)
    synthesize({**config, "phrases": [{"id": "b", "text": "Мир", "voice": "demo"}]}, events, models)
    constructor.assert_called_once()
    assert model.inference_cross_lingual.call_count == 2
    clips = [json.loads(line) for line in events.getvalue().splitlines()]
    assert [e["id"] for e in clips if e["kind"] == "synthesized"] == ["a", "b"]
