"""Disposable video preparation process; never imported by the API."""

import json
import shutil
import subprocess
import sys
import traceback
import wave
from pathlib import Path

from .worker import emit, prepare, stage


def acquire(config):
    import yt_dlp

    def public_recording(info, *, incomplete):
        if info.get("is_live") or info.get("live_status") in {
            "is_live",
            "is_upcoming",
            "post_live",
        }:
            return "Only finished recordings are supported"
        if not incomplete and info.get("availability") != "public":
            return "Only public recordings are supported"
        return None

    def progress(data):
        stage(
            "acquisition",
            completed_units=data.get("downloaded_bytes", 0),
            total_units=data.get("total_bytes") or data.get("total_bytes_estimate"),
            unit="bytes",
        )

    with yt_dlp.YoutubeDL(
        {
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best",
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "outtmpl": str(Path(config["directory"]) / "download.%(ext)s"),
            "match_filter": public_recording,
            "progress_hooks": [progress],
            "js_runtimes": {"node": {}},
        }
    ) as downloader:
        info = downloader.extract_info(config["source"]["url"], download=True)
        if (
            not info
            or info.get("_type") in {"playlist", "multi_video"}
            or public_recording(info, incomplete=False)
        ):
            raise ValueError("Unsupported YouTube source")
        shutil.move(downloader.prepare_filename(info), config["source_path"])
        if info.get("title"):
            emit(kind="source_metadata", title=info["title"])


def render(config):
    directory = Path(config["directory"])
    duration = float(config["duration"])
    total = max(duration * 2, 0.001)
    submitted = 0
    reported = -1.0

    def progress(seconds, detail):
        nonlocal reported
        seconds = min(max(seconds, 0), total * 0.99)
        if seconds > reported:
            stage(
                "rendering",
                completed_units=seconds,
                total_units=total,
                unit="seconds",
                detail=detail,
            )
            reported = seconds

    progress(0, "Сборка аудиодорожки")
    with subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "s16le",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
            str(directory / "translation.m4a"),
        ],
        stdin=subprocess.PIPE,
    ) as process:
        assert process.stdin
        position = 0

        def write_audio(chunk):
            nonlocal submitted
            assert process.stdin
            process.stdin.write(chunk)
            submitted += len(chunk) // 2
            progress(min(submitted / 24000, duration), "Сборка аудиодорожки")

        def silence(frames):
            assert process.stdin
            while frames > 0:
                count = min(frames, 24000)
                write_audio(b"\x00" * count * 2)
                frames -= count

        for clip in config["placements"]:
            start = round(clip["start"] * 24000)
            silence(start - position)
            with wave.open(clip["path"], "rb") as source:
                if source.getparams()[:3] != (1, 2, 24000):
                    raise ValueError("Unexpected clip format")
                while chunk := source.readframes(24000):
                    write_audio(chunk)
                position = start + source.getnframes()
        silence(round(config["duration"] * 24000) - position)
        process.stdin.close()
        if process.wait():
            raise ValueError("Audio rendering failed")
    tail = max(0, config["duration"] - config.get("source_duration", config["duration"]))
    progress(duration, "Кодирование видео")
    with subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            str(directory / "source"),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            *(
                [
                    "-vf",
                    f"tpad=stop_mode=clone:stop_duration={tail}",
                    "-af",
                    f"apad=pad_dur={tail}",
                    "-t",
                    str(config["duration"]),
                ]
                if tail > 0
                else []
            ),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
            str(directory / "video.mp4"),
        ],
        stdout=subprocess.PIPE,
        text=True,
    ) as video_process:
        assert video_process.stdout
        for line in video_process.stdout:
            key, _, value = line.strip().partition("=")
            if key == "out_time_us":
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    continue
                progress(duration + min(seconds, duration), "Кодирование видео")
        if video_process.wait():
            raise ValueError("Video rendering failed")
    stage(
        "rendering",
        state="completed",
        completed_units=total,
        total_units=total,
        unit="seconds",
        detail="Файлы собраны",
    )


def main():
    config = json.loads(sys.stdin.readline())
    sys.stdout = sys.stderr
    try:
        if sys.argv[1] == "pauses":
            from .pause_processing import compress_pauses

            for clip in config["clips"]:
                path, duration = compress_pauses(clip["path"])
                emit(kind="synthesized", id=clip["id"], path=path, duration=duration)
            emit(kind="done")
            return
        if sys.argv[1] == "fit":
            speed = config["speed"]
            if not 1 <= speed <= 1.15:
                raise ValueError("Unsupported speech speed")
            for clip in config["clips"]:
                destination = str(Path(clip["path"]).with_suffix(".fitted.wav"))
                subprocess.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-i",
                        clip["path"],
                        "-af",
                        f"atempo={speed}",
                        "-c:a",
                        "pcm_s16le",
                        "-y",
                        destination,
                    ],
                    check=True,
                )
                with wave.open(destination, "rb") as source:
                    duration = source.getnframes() / source.getframerate()
                emit(kind="synthesized", id=clip["id"], path=destination, duration=duration)
            emit(kind="done")
            return
        if sys.argv[1] == "render":
            render(config)
            emit(kind="done")
            return
        if config["source"]["kind"] == "youtube":
            acquire(config)
            config["source"] = {"kind": "file", "name": "source"}
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-show_streams",
                "-of",
                "json",
                config["source_path"],
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        kinds = {stream["codec_type"] for stream in json.loads(probe.stdout)["streams"]}
        if not {"video", "audio"} <= kinds:
            raise ValueError("Video with audio required")
        prepare(config)
        emit(kind="done")
    except Exception as error:  # noqa: BLE001 -- sanitize third-party failures at the process boundary
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
        emit(kind="error", code="invalid_media")
        sys.exit(1)


if __name__ == "__main__":
    main()
