"""Deterministic external model process used by HTTP and browser acceptance tests."""

import json
import sys
import time

role = sys.argv[1]
config = json.loads(sys.stdin.readline())
scenario = config["source"].get("name", "")


def emit(**event):
    print(json.dumps(event), flush=True)


if role == "preparation":
    if scenario in {"real.wav", "real.mp4"}:
        from transcription.worker import prepare

        prepare(config)
    else:
        emit(
            kind="prepared",
            path=config["source_path"],
            duration=9 if scenario.startswith("blocks-") else 3,
        )
elif role == "asr":
    if scenario == "asr-error":
        emit(kind="error", code="ModelError")
        sys.exit(1)
    emit(kind="stage", name="asr_model", state="completed")
    emit(
        kind="stage",
        name="asr",
        state="running",
        total_units=9 if scenario.startswith("blocks-") else 3,
        unit="seconds",
    )
    emit(
        kind="words",
        language="ru",
        words=[
            {"start": 0, "end": 1, "text": "Привет,"},
            {"start": 1, "end": 2, "text": " мир!"},
            {"start": 2, "end": 3, "text": " Пока."},
        ],
    )
    if scenario.startswith("blocks-"):
        time.sleep(0.4)
        for word in [
            {"start": 7, "end": 8, "text": " Продолжение."},
            {"start": 8, "end": 9, "text": " Ответ."},
        ]:
            emit(kind="words", language="ru", words=[word])
    time.sleep(30 if scenario == "wait" else 3 if scenario == "live-speakers" else 0.3)
else:
    emit(kind="stage", name="diarization_model", state="completed")
    emit(kind="stage", name="diarization", state="running")
    time.sleep(
        30
        if scenario == "wait"
        else 1.5
        if scenario == "live-speakers"
        else 0.8
        if scenario == "blocks-late"
        else 0.15
    )
    if scenario == "diarization-error":
        emit(kind="error", code="GatedRepoError")
        sys.exit(1)
    emit(
        kind="turns",
        turns=[
            {"start": 0, "end": 1, "speaker_id": "B"},
            {"start": 1, "end": 8 if scenario.startswith("blocks-") else 3, "speaker_id": "A"},
            {"start": 1.5, "end": 2, "speaker_id": "B"},
            *(
                [{"start": 8, "end": 9, "speaker_id": "B"}]
                if scenario.startswith("blocks-")
                else []
            ),
        ],
    )
emit(kind="done")
