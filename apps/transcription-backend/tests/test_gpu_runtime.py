"""Opt-in runtime acceptance; never imports models or downloads weights."""

import os
import subprocess
import sys

import pytest


@pytest.mark.skipif(
    os.environ.get("RUN_GPU_TESTS") != "1", reason="requires installed GPU extra and physical GPUs"
)
def test_cuda_and_cudnn_load_on_the_selected_physical_devices():
    for device in ("NVIDIA GeForce RTX 5080", "NVIDIA GeForce RTX 4070 Ti"):
        subprocess.run(
            [
                sys.executable,
                "-c",
                """
import sys
from transcription.worker import select_gpu
select_gpu(sys.argv[1])
import torch, ctranslate2
assert torch.cuda.get_device_name(0) == sys.argv[1]
assert 'float16' in ctranslate2.get_supported_compute_types('cuda', 0)
model = torch.nn.LSTM(4, 4).to('cuda')
model(torch.zeros(1, 1, 4, device='cuda'))
torch.cuda.synchronize()
print(torch.cuda.get_device_name(0), torch.backends.cudnn.version())
""",
                device,
            ],
            check=True,
        )


@pytest.mark.skipif(
    os.environ.get("RUN_MODEL_TESTS") != "1", reason="explicit cached-model acceptance only"
)
def test_cached_models_complete_multi_batch_audio_through_http(tmp_path):
    import wave

    from fastapi.testclient import TestClient
    from test_api import BASE, terminal

    from transcription.api import create_app
    from transcription.config import Settings

    audio = tmp_path / "silence.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0" * 16000 * 2 * 600)
    with TestClient(create_app(Settings(data_dir=tmp_path / "results"))) as client:
        operation = client.post(
            f"{BASE}/operations",
            json={
                "source_kind": "file",
                "filename": "silence.wav",
                "language": "en",
                "client_request_id": "multi-batch",
            },
        ).json()
        client.put(
            f"{BASE}/operations/{operation['operation_id']}/source", content=audio.read_bytes()
        )
        result = terminal(client, operation["operation_id"], timeout=90)
        assert result["status"] == "completed", result["error"]
        assert result["completeness"] == {"asr": True, "diarization": True}


@pytest.mark.skipif(
    not os.environ.get("GIGAAM_TEST_AUDIO"), reason="explicit Russian recording acceptance only"
)
@pytest.mark.parametrize("language", ["ru", "auto"])
def test_russian_recording_uses_gigaam_with_word_timestamps_and_speaker_blocks(tmp_path, language):
    import json
    from pathlib import Path

    from fastapi.testclient import TestClient
    from test_api import BASE, terminal

    from transcription.api import create_app
    from transcription.config import Settings

    audio = tmp_path / "russian.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            os.environ["GIGAAM_TEST_AUDIO"],
            "-t",
            "45",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(audio),
        ],
        check=True,
    )
    with TestClient(create_app(Settings(data_dir=tmp_path / "results"))) as client:
        op = client.post(
            f"{BASE}/operations",
            json={
                "source_kind": "file",
                "filename": audio.name,
                "language": language,
                "client_request_id": "gigaam-russian",
            },
        ).json()
        client.put(f"{BASE}/operations/{op['operation_id']}/source", content=audio.read_bytes())
        result = terminal(client, op["operation_id"], timeout=240)
        assert result["status"] == "completed", result["error"]
        document = json.loads(Path(result["output_paths"]["json"]).read_text())
        assert document["models"]["asr"]["id"] == "ai-sage/GigaAM-v3"
        assert document["models"]["asr"]["variant"] == "e2e_rnnt"
        assert document["language"]["detected"] == "ru"
        assert document["segments"] == result["segments"]
        assert len(document["segments"]) > 1
        assert all(0 <= s["start"] <= s["end"] <= 45 for s in document["segments"])
        assert len("".join(s["text"] for s in document["segments"])) > 100
        assert result["completeness"] == {"asr": True, "diarization": True}
