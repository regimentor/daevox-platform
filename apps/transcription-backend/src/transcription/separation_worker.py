"""Standalone local speech/background separation adapter."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

from .worker import emit, select_gpu


def verify_checkpoint(path: str, expected_sha256: str):
    checkpoint = Path(path)
    if not checkpoint.is_file():
        raise ValueError("Install the pinned Demucs checkpoint before separation")
    with checkpoint.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected_sha256:
        raise ValueError("Demucs checkpoint SHA-256 mismatch")


def main():
    config = json.loads(sys.stdin.readline())
    sys.stdout = sys.stderr
    try:
        verify_checkpoint(
            config["separation_checkpoint_path"], config["separation_checkpoint_sha256"]
        )
        select_gpu(config["tts_gpu"])
        directory = Path(config["directory"])
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "demucs.separate",
                    "--two-stems",
                    "vocals",
                    "--name",
                    config["separation_model"],
                    "--device",
                    "cuda",
                    "--out",
                    temporary,
                    config["audio_path"],
                ],
                check=True,
                stdout=sys.stderr,
                stderr=sys.stderr,
            )
            stem_directory = (
                Path(temporary) / config["separation_model"] / Path(config["audio_path"]).stem
            )
            outputs = {
                "vocals_path": (stem_directory / "vocals.wav", directory / "vocals.wav"),
                "background_path": (
                    stem_directory / "no_vocals.wav",
                    directory / "background.wav",
                ),
            }
            for source, destination in outputs.values():
                if not source.is_file():
                    raise ValueError("Demucs did not produce the requested stems")
                shutil.copyfile(source, destination)
        emit(
            kind="separated",
            vocals_path=str(outputs["vocals_path"][1]),
            background_path=str(outputs["background_path"][1]),
        )
        emit(kind="done")
    except Exception as error:  # noqa: BLE001 -- external model boundary
        if config.get("diagnostic_path"):
            emit(
                kind="diagnostic",
                event="worker.exception",
                error_type=type(error).__name__,
                message=str(error),
                traceback=traceback.format_exc(),
                stderr=str(getattr(error, "stderr", "") or ""),
                stdout=str(getattr(error, "stdout", "") or ""),
            )
        emit(kind="error", code="separation_failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
