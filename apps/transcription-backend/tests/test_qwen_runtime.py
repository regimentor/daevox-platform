import subprocess
import venv
from pathlib import Path

import pytest

from transcription.config import load_settings
from transcription.voiceover import Voiceovers


@pytest.mark.parametrize("engine", ["qwen", "chatterbox", "cosyvoice"])
def test_tts_interpreter_keeps_virtualenv_when_loading_and_launching(tmp_path, monkeypatch, engine):
    environment = tmp_path / "tts-env"
    venv.EnvBuilder(with_pip=False, symlinks=True).create(environment)
    python = environment / "bin" / "python"
    site = subprocess.check_output(
        [str(python), "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], text=True
    ).strip()
    (Path(site) / "qwen_runtime_marker.py").write_text("READY = True\n")
    monkeypatch.setenv(f"TRANSCRIPTION_{engine.upper()}_PYTHON", str(python))
    monkeypatch.setenv("TRANSCRIPTION_TTS_ENGINE", engine)
    monkeypatch.setenv("TRANSCRIPTION_DATA_DIR", str(tmp_path / "data"))
    settings = load_settings()
    service = Voiceovers(settings)
    result = subprocess.run(
        [
            service.tts_command[0],
            "-c",
            "import qwen_runtime_marker; assert qwen_runtime_marker.READY",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_missing_module_diagnostic_survives_worker_and_record_boundary(tmp_path, caplog):
    import asyncio
    import sys

    from transcription.config import Settings
    from transcription.voiceover import VoiceoverSnapshot

    message = "В окружении озвучки отсутствует Python-модуль «qwen_tts»."
    worker = tmp_path / "worker.py"
    worker.write_text(
        "import json\n"
        f"print(json.dumps({{'kind': 'error', 'code': 'missing_dependency', 'message': {message!r}}}))\n"
    )
    service = Voiceovers(Settings(data_dir=tmp_path / "data"), [sys.executable, str(worker)])
    record = VoiceoverSnapshot(
        id="diagnostic-test",
        created_at="2026-09-11T00:00:00+00:00",
        source={"kind": "file", "name": "video.mp4"},
        status="preparing",
    )
    service.records[record.id] = record
    asyncio.run(service.prepare(record))
    assert record.error == {"code": "missing_dependency", "message": message}
    assert any(
        getattr(entry, "operation_id", None) == record.id
        and getattr(entry, "code", None) == "missing_dependency"
        and message in entry.getMessage()
        for entry in caplog.records
    )
