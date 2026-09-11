from pathlib import Path
from unittest.mock import patch

import pytest

from transcription.separation_worker import main, verify_checkpoint


def test_separation_rejects_an_unverified_checkpoint(tmp_path):
    checkpoint = tmp_path / "model.th"
    checkpoint.write_bytes(b"unexpected")

    with pytest.raises(ValueError, match="SHA-256"):
        verify_checkpoint(str(checkpoint), "0" * 64)


def test_demucs_output_is_kept_off_the_worker_json_channel(tmp_path, monkeypatch):
    checkpoint = tmp_path / "model.th"
    checkpoint.write_bytes(b"verified")
    audio = tmp_path / "audio.wav"
    audio.touch()
    config = {
        "tts_gpu": "gpu",
        "directory": str(tmp_path),
        "audio_path": str(audio),
        "separation_model": "htdemucs",
        "separation_checkpoint_path": str(checkpoint),
        "separation_checkpoint_sha256": __import__("hashlib").sha256(b"verified").hexdigest(),
    }
    monkeypatch.setattr("sys.stdin.readline", lambda: __import__("json").dumps(config))

    def run(command, **options):
        assert options["stdout"] is options["stderr"]
        stem = Path(command[command.index("--out") + 1]) / "htdemucs" / "audio"
        stem.mkdir(parents=True)
        (stem / "vocals.wav").touch()
        (stem / "no_vocals.wav").touch()

    with (
        patch("transcription.separation_worker.select_gpu"),
        patch("transcription.separation_worker.subprocess.run", side_effect=run),
    ):
        main()

    assert (tmp_path / "vocals.wav").is_file()
    assert (tmp_path / "background.wav").is_file()
