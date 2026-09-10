"""One disposable process per phase. Model imports and downloads only happen here."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

_protocol = sys.stdout


def emit(**event):
    _protocol.write(json.dumps(event, ensure_ascii=False) + "\n")
    _protocol.flush()


def stage(name, state="running", completed_units=0, total_units=None, unit="", detail=None):
    emit(
        kind="stage",
        name=name,
        state=state,
        completed_units=float(completed_units),
        total_units=float(total_units) if total_units is not None else None,
        unit=unit,
        detail=detail,
    )


class SourceError(Exception):
    pass


class ModelAccessError(Exception):
    pass


def prepare(config):
    source = Path(config["source_path"])
    directory = Path(config["directory"])
    if config["source"]["kind"] == "youtube":
        import yt_dlp

        last_progress = 0.0

        def progress(data):
            nonlocal last_progress
            now = time.monotonic()
            if now - last_progress >= 0.2 or data["status"] == "finished":
                stage(
                    "acquisition",
                    completed_units=data.get("downloaded_bytes", 0),
                    total_units=data.get("total_bytes") or data.get("total_bytes_estimate"),
                    unit="bytes",
                )
                last_progress = now

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

        stage("acquisition", unit="bytes")
        options = {
            "format": "bestaudio/best",
            "noplaylist": True,
            "quiet": True,
            "outtmpl": str(directory / "download.%(ext)s"),
            "progress_hooks": [progress],
            "match_filter": public_recording,
            "js_runtimes": {"node": {}},
            "overwrites": False,
        }
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(config["source"]["url"], download=True)
            if (
                not info
                or info.get("_type") in {"playlist", "multi_video"}
                or public_recording(info, incomplete=False)
            ):
                raise SourceError()
            source = Path(downloader.prepare_filename(info))
        stage("acquisition", "completed")
    stage("preparation", unit="seconds")
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(source),
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    duration_value = json.loads(probe.stdout).get("format", {}).get("duration")
    duration = float(duration_value) if duration_value else None
    audio = directory / "audio.wav"
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe,crypto,data",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-rf64",
        "auto",
        "-progress",
        "pipe:1",
        "-y",
        str(audio),
    ]
    with subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    ) as process:
        assert process.stdout
        for line in process.stdout:
            if line.startswith("out_time_us="):
                value = line.strip().partition("=")[2]
                if value.isdigit():
                    stage(
                        "preparation",
                        completed_units=int(value) / 1_000_000,
                        total_units=duration,
                        unit="seconds",
                    )
        if process.wait():
            raise SourceError()
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(audio)],
        capture_output=True,
        check=True,
        text=True,
    )
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    emit(kind="prepared", path=str(audio), duration=duration)


def select_gpu(selection: str):
    # Names/UUIDs are stable across the differing CUDA and nvidia-smi ordinal orders.
    os.environ["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
    if selection.isdigit() or selection.startswith("GPU-"):
        os.environ["CUDA_VISIBLE_DEVICES"] = selection
        return
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,uuid", "--format=csv,noheader"],
        capture_output=True,
        text=True,
        check=True,
    )
    matches = [
        row.partition(",")[2].strip()
        for row in result.stdout.splitlines()
        if row.partition(",")[0].strip() == selection
    ]
    if len(matches) != 1:
        raise RuntimeError("GPU selection is ambiguous or unavailable")
    os.environ["CUDA_VISIBLE_DEVICES"] = matches[0]


def recognize(config):
    select_gpu(config["asr_gpu"])
    if config["language"] == "ru":
        from .gigaam import recognize_russian

        recognize_russian(config, emit, stage)
        return
    stage("asr_model", detail="Скачивание весов или чтение кэша и загрузка на GPU")
    import ctranslate2
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download

    if "float16" not in ctranslate2.get_supported_compute_types("cuda", 0):
        raise RuntimeError("CUDA FP16 is unavailable")
    model_id = "Systran/faster-whisper-large-v3"
    path = snapshot_download(
        model_id,
        revision=config["asr_revision"],
        allow_patterns=[
            "config.json",
            "preprocessor_config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
        ],
    )
    model = WhisperModel(path, device="cuda", device_index=0, compute_type="float16")
    segments, info = model.transcribe(
        config["audio_path"],
        language=None if config["language"] == "auto" else config["language"],
        task="transcribe",
        word_timestamps=True,
        beam_size=5,
        # Video dubbing must not turn carried context or an outro pause into extra speech.
        condition_on_previous_text=not config.get("voiceover", False),
        vad_filter=config.get("voiceover", False),
    )
    if config["language"] == "auto" and info.language == "ru":
        import gc

        from .gigaam import recognize_russian

        # The lazy Whisper iterator has not decoded text. Release its GPU model before GigaAM.
        del segments, model
        gc.collect()
        recognize_russian(config, emit, stage)
        return
    emit(
        kind="model",
        model={
            "id": model_id,
            "revision": Path(path).name,
            "device": config["asr_gpu"],
            "compute_type": "float16",
            "engine": ctranslate2.__version__,
        },
    )
    stage("asr_model", "completed")
    stage("asr", total_units=config["duration"], unit="seconds")
    for segment in segments:
        words = [
            {"start": word.start, "end": word.end, "text": word.word}
            for word in segment.words or []
        ]
        # Preserve model text even if timestamps are absent (e.g. a non-speech token).
        if not words or "".join(word["text"] for word in words) != segment.text:
            words = [{"start": segment.start, "end": segment.end, "text": segment.text}]
        emit(kind="words", language=info.language, words=words)
        stage("asr", completed_units=segment.end, total_units=info.duration, unit="seconds")
    stage(
        "asr", "completed", completed_units=info.duration, total_units=info.duration, unit="seconds"
    )


def diarize(config):
    select_gpu(config["diarization_gpu"])
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    stage("diarization_model", detail="Скачивание весов или чтение кэша и загрузка на GPU")
    import torch
    from huggingface_hub import hf_hub_download
    from pyannote.audio import Pipeline

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    model_id = "pyannote/speaker-diarization-community-1"
    # Resolve an immutable revision, including when it is served from the cache.
    config_path = hf_hub_download(model_id, "config.yaml", revision=config["diarization_revision"])
    revision = Path(config_path).parent.name
    pipeline = Pipeline.from_pretrained(model_id, revision=revision)
    if pipeline is None:
        raise ModelAccessError()
    pipeline.to(torch.device("cuda:0"))
    emit(
        kind="model",
        model={
            "id": model_id,
            "revision": revision,
            "device": config["diarization_gpu"],
            "device_name": torch.cuda.get_device_name(0),
            "engine": torch.__version__,
        },
    )
    stage("diarization_model", "completed")
    stage("diarization")
    last_progress = 0.0

    def progress(step_name, step_artifact, file=None, total=None, completed=None):
        nonlocal last_progress
        now = time.monotonic()
        if now - last_progress >= 0.2 or (total is not None and total == completed):
            stage(
                "diarization",
                completed_units=completed or 0,
                total_units=total,
                unit="batches",
                detail=step_name,
            )
            last_progress = now

    result = pipeline(config["audio_path"], hook=progress)
    if not hasattr(result, "speaker_diarization"):
        raise RuntimeError("Unexpected diarization output")
    turns = [
        {"start": turn.start, "end": turn.end, "speaker_id": speaker}
        for turn, _, speaker in result.speaker_diarization.itertracks(yield_label=True)
    ]
    emit(kind="turns", turns=turns)
    stage("diarization", "completed")


def main():
    # Third-party prints must never corrupt the protocol or expose credentials to API clients.
    sys.stdout = sys.stderr
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    config = json.loads(sys.stdin.readline())
    role = sys.argv[1]
    try:
        {"preparation": prepare, "asr": recognize, "diarization": diarize}[role](config)
        emit(kind="done")
    except Exception as error:  # noqa: BLE001 -- process boundary: sanitize third-party failures
        emit(kind="error", code=type(error).__name__)
        sys.exit(1)


if __name__ == "__main__":
    main()
