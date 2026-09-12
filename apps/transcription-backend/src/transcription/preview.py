"""Append-only speech timeline encoded into an event HLS playlist."""

import asyncio
import re
import wave
from pathlib import Path
from typing import BinaryIO

from .processes import WorkerFailure

RATE = 24000


class PreviewStream:
    def __init__(self, directory: Path, config: dict):
        self.directory = directory
        self.config = config
        self.position = 0
        self.process: asyncio.subprocess.Process | None = None
        self.error_log: BinaryIO | None = None
        self.finished = False

    async def start(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        args = [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(RATE),
            "-ac",
            "1",
            "-i",
            "pipe:0",
        ]
        mode = self.config.get("background_mode")
        background = (
            self.config.get("background_path")
            if mode == "separated"
            else self.config.get("audio_path")
            if mode == "original_ducked"
            else None
        )
        if background and Path(background).is_file():
            volume = "0.85" if mode == "separated" else "0.18"
            args += [
                "-i",
                str(background),
                "-filter_complex",
                f"[1:a]volume={volume}[bg];[bg][0:a]amix=inputs=2:duration=shortest:normalize=0,alimiter=limit=0.95[a]",
                "-map",
                "[a]",
            ]
        else:
            args += ["-af", "alimiter=limit=0.95"]
        args += [
            "-ar",
            str(RATE),
            "-ac",
            "1",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_list_size",
            "0",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "temp_file",
            "-hls_segment_filename",
            str(self.directory / "segment%06d.ts"),
            str(self.directory / "index.m3u8"),
        ]
        self.error_log = (self.directory / "encoder.log").open("wb")
        self.process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=self.error_log,
        )

    async def append(self, end: float, placements: list[dict]):
        if self.process is None:
            await self.start()
        assert self.process and self.process.stdin
        stop = round(end * RATE)
        # Small writes bound memory and yield to translation, synthesis, and HTTP requests.
        while self.position < stop:
            count = min(RATE, stop - self.position)
            pcm = bytearray(count * 2)
            for clip in placements:
                clip_start = round(clip["start"] * RATE)
                clip_end = clip_start + round(clip["duration"] * RATE)
                start = max(self.position, clip_start)
                finish = min(self.position + count, clip_end)
                if start >= finish:
                    continue
                with wave.open(clip["path"], "rb") as source:
                    if source.getparams()[:3] != (1, 2, RATE):
                        raise ValueError("Unexpected preview clip format")
                    source.setpos(min(start - clip_start, source.getnframes()))
                    data = source.readframes(finish - start)
                offset = (start - self.position) * 2
                pcm[offset : offset + len(data)] = data
            self.process.stdin.write(pcm)
            await self.process.stdin.drain()
            self.position += count
            await asyncio.sleep(0)
        if self.process.returncode is not None:
            raise WorkerFailure("preview_encoder_failed")

    def available(self) -> float:
        playlist = self.directory / "index.m3u8"
        if not playlist.exists():
            return 0
        return sum(float(value) for value in re.findall(r"#EXTINF:([\d.]+)", playlist.read_text()))

    async def finish(self):
        if self.finished:
            return
        if self.process:
            assert self.process.stdin
            self.process.stdin.close()
            if await asyncio.wait_for(self.process.wait(), 30):
                raise WorkerFailure("preview_encoder_failed")
        self.finished = True

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.error_log:
            self.error_log.close()


def preview_file(directory: Path, name: str) -> Path:
    if not (name == "index.m3u8" or re.fullmatch(r"segment\d+\.ts", name)):
        raise ValueError("Invalid preview asset")
    return directory / name
