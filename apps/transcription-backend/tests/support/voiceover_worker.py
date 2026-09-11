"""External model double. Video decoding and application coordination remain real."""

import json
import sys
import time

role = sys.argv[1]
config = json.loads(sys.stdin.readline())


def emit(**event):
    print(json.dumps(event), flush=True)


overlap = config["source"].get("name") == "overlap.mp4"

if (
    config["source"].get("name") == "second-gpu.mp4"
    and role in {"asr", "diarization", "tts"}
    and config[f"{role}_gpu"] != "NVIDIA GeForce RTX 4070 Ti"
):
    emit(kind="error", code="wrong_gpu")
    sys.exit(1)

if role == "voiceover_preparation":
    import subprocess
    from pathlib import Path

    if config["source"]["kind"] == "youtube":
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x90:d=3",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                "-y",
                "-f",
                "mp4",
                config["source_path"],
            ],
            check=True,
        )
        config["source"] = {"kind": "file", "name": "download.mp4"}
    result = subprocess.run(
        [sys.executable, "-m", "transcription.video_worker", "preparation"],
        input=json.dumps(config),
        text=True,
        check=False,
    )
    sys.exit(result.returncode)
elif role == "asr":
    if config["source"].get("name") == "asr-recheck.mp4":
        import subprocess

        result = subprocess.run(
            [sys.executable, "-m", "transcription.worker", role],
            input=json.dumps(config),
            text=True,
            check=False,
        )
        sys.exit(result.returncode)
    if config["source"].get("name") == "repeated-terms.mp4":
        emit(
            kind="words",
            language="en",
            words=[{"start": 0, "end": 2, "text": "Rust uses GPUs because Rust is fast."}],
        )
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "semantic-window.mp4":
        emit(
            kind="words",
            language="en",
            words=[
                {"start": 0, "end": 1, "text": "The reason Rust is used on GPUs."},
                {"start": 1, "end": 2, "text": " Is the same reason it is used elsewhere."},
            ],
        )
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") in {"protected-terms.mp4", "plural-gpu.mp4"}:
        emit(
            kind="words",
            language="en",
            words=[
                {
                    "start": 0,
                    "end": 2,
                    "text": "Rust needs 4096 GPU cores."
                    if config["source"].get("name") == "protected-terms.mp4"
                    else "Rust needs 4096 cores on GPUs.",
                }
            ],
        )
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "zero-time-words.mp4":
        emit(
            kind="words",
            language="en",
            words=[
                {"start": 0, "end": 0.8, "text": "The code."},
                {"start": 1, "end": 1, "text": " Works."},
                {"start": 1, "end": 1, "text": " Well."},
            ],
        )
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "whole-sentence.mp4":
        emit(
            kind="words",
            language="en",
            words=[
                {"start": 0, "end": 1, "text": "This"},
                {"start": 7, "end": 8, "text": " is"},
                {"start": 8, "end": 9, "text": " one"},
                {"start": 9, "end": 10, "text": " sentence."},
            ],
        )
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "gpu-failure.mp4":
        emit(kind="error", code="OutOfMemoryError")
        sys.exit(1)
    emit(kind="stage", name="asr", state="running", completed_units=0, unit="seconds")
    emit(
        kind="words",
        language="en",
        words=(
            [{"start": i * 0.04, "end": i * 0.04 + 0.02, "text": "Hello."} for i in range(60)]
            if config["source"].get("name") == "long-transcript.mp4"
            else [
                {"start": 0, "end": 0.4, "text": "Hello."},
                {
                    "start": 0.2 if overlap else 1,
                    "end": 0.6 if overlap else 1.5,
                    "text": " Goodbye.",
                },
            ]
        ),
    )
    if config["source"].get("name") == "live.mp4":
        time.sleep(1)
    emit(kind="stage", name="asr", state="completed", completed_units=2, unit="seconds")
elif role == "diarization":
    if config["source"].get("name") == "semantic-window.mp4":
        emit(kind="turns", turns=[{"start": 0, "end": 3, "speaker_id": "A"}])
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "zero-time-words.mp4":
        emit(kind="turns", turns=[{"start": 0, "end": 3, "speaker_id": "A"}])
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "whole-sentence.mp4":
        emit(kind="turns", turns=[{"start": 0, "end": 11, "speaker_id": "A"}])
        emit(kind="done")
        sys.exit(0)
    if config["source"].get("name") == "live.mp4":
        time.sleep(0.5)
    emit(
        kind="turns",
        turns=[
            {"start": 0, "end": 0.5, "speaker_id": "A"},
            {"start": 0.2 if overlap else 1, "end": 0.6 if overlap else 1.6, "speaker_id": "B"},
        ],
    )
elif role in {"translation", "shorten"}:
    if config.get("llm_model") == "translation-test-server":
        import subprocess

        result = subprocess.run(
            [sys.executable, "-m", "transcription.voice_worker", role],
            input=json.dumps(config),
            text=True,
            check=False,
        )
        sys.exit(result.returncode)
    for phrase, text in zip(config["phrases"], ["Привет.", "До свидания."]):
        if (
            config["source"].get("name") == "translation-failure.mp4"
            and phrase == config["phrases"][0]
        ):
            emit(kind="translation", id=phrase["id"], text="", status="failed")
        else:
            if config["source"].get("name") == "adaptive-fit.mp4" and role == "shorten":
                text = "Здравствуй." if phrase["text"] == "Привет!" else "Привет!"
            else:
                text = "Привет!" if role == "shorten" else text
            emit(
                kind="translation",
                id=phrase["id"],
                text=text,
                **(
                    {
                        "status": "warning",
                        "warnings": [{"code": "semantic_review", "message": "Проверьте смысл."}],
                    }
                    if config["source"].get("name") == "advisory.mp4"
                    else {}
                ),
                **(
                    {"candidates": [text, "Да.", "Здравствуйте."]}
                    if config["source"].get("name") == "candidate-fit.mp4"
                    else {}
                ),
            )
elif role == "tts":
    import wave
    from pathlib import Path

    for phrase in config["phrases"]:
        if config["source"].get("name") == "tts-failure.mp4" and phrase["text"] == "Привет.":
            emit(kind="synthesis_failed", id=phrase["id"])
            continue
        destination = Path(config["directory"]) / (phrase["id"] + ".wav")
        with wave.open(str(destination), "wb") as output:
            output.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            duration = (
                (
                    1.3
                    if config["source"].get("name") == "too-long.mp4"
                    or (
                        config["source"].get("name") == "rephrase.mp4"
                        and phrase["text"] == "Привет."
                    )
                    else 1.1
                    if config["source"].get("name") == "fits.mp4"
                    else 0.25
                )
                if phrase == config["phrases"][0]
                else 0.25
            )
            if config["source"].get("name") == "adaptive-fit.mp4" and phrase["id"] == "0-0":
                duration = {"Привет.": 1.3, "Привет!": 1.2, "Здравствуй.": 0.9}[phrase["text"]]
            if config["source"].get("name") == "voiceover-tail.mp4" and phrase["id"] != "0-0":
                duration = 4
            if config["source"].get("name") == "candidate-fit.mp4":
                duration = {"Привет.": 2, "До свидания.": 2, "Да.": 1.5, "Здравствуйте.": 0.8}.get(
                    phrase["text"], 2
                )
            if config["source"].get("name") == "pace-fit.mp4":
                duration = 0.8 if "brisk" in phrase.get("instruction", "") else 4
            if config["source"].get("name") == "pause-fit.mp4":
                output.writeframes(b"\x00\x20" * 9600 + b"\x00\x00" * 28800 + b"\x00\x20" * 9600)
                duration = 2
            else:
                output.writeframes(b"\x01\x00" * round(duration * 24000))
        emit(kind="synthesized", id=phrase["id"], path=str(destination), duration=duration)
emit(kind="done")
