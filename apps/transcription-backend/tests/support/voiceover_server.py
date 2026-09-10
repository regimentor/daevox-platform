"""Test-only API bootstrap; production has no fake-model environment switch."""

import sys
import tempfile
from pathlib import Path

import uvicorn

from transcription.api import create_app
from transcription.config import Settings

with tempfile.TemporaryDirectory(prefix="daevox-transcription-e2e-") as directory:
    uvicorn.run(
        create_app(
            Settings(data_dir=Path(directory)),
            worker_command=[sys.executable, str(Path(__file__).with_name("voiceover_worker.py"))],
        ),
        host="127.0.0.1",
        port=3003,
    )
