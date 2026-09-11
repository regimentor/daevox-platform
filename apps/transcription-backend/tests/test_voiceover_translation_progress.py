import asyncio
import json
import wave
from pathlib import Path

from transcription.config import Settings
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_dubbing_finishes_one_phrase_before_translating_the_next(tmp_path, monkeypatch):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="progress",
        created_at="2026-09-12T00:00:00Z",
        source={"kind": "file", "name": "test.mp4"},
        status="synthesizing",
        duration=3,
        transcript=[
            {"id": "a", "start": 0, "end": 0.4, "text": "Hello.", "speaker_id": "one"},
            {"id": "b", "start": 1, "end": 1.5, "text": "Goodbye.", "speaker_id": "one"},
        ],
        voice_assignments={"one": "aidar"},
    )
    service.records[record.id] = record
    service.directory(record.id).mkdir(parents=True)
    operations = []
    progress = []

    async def worker(command, role, config, receive):
        if role in {"translation", "tts", "shorten"}:
            assert len(config["phrases"]) == 1
            phrase = config["phrases"][0]
            operations.append((role, phrase["id"]))
        if role in {"translation", "shorten"}:
            receive(
                {
                    "kind": "translation",
                    "id": phrase["id"],
                    "text": "Коротко."
                    if role == "shorten"
                    else ("Полный перевод." if phrase["id"] == "a" else "Прощание."),
                }
            )
        elif role == "tts":
            duration = 1.7 if phrase["id"] == "a" and phrase["text"] == "Полный перевод." else 0.5
            path = Path(config["directory"]) / f"{phrase['id']}.wav"
            with wave.open(str(path), "wb") as audio:
                audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\x01\x00" * round(duration * 24000))
            receive(
                {"kind": "synthesized", "id": phrase["id"], "path": str(path), "duration": duration}
            )
        elif role == "fit":
            operations.append((role, config["clips"][0]["id"]))
            assert 1 <= config["speed"] <= 1.5
            for clip in config["clips"]:
                receive(
                    {**clip, "kind": "synthesized", "duration": clip["duration"] / config["speed"]}
                )
        progress.append(
            service.library(None, 20)["items"][0]["stages"]["dubbing"]["completed_units"]
        )

    monkeypatch.setattr("transcription.voiceover.run_worker", worker)
    asyncio.run(service.render(record))
    assert record.status == "completed", record.error
    assert operations == [
        ("translation", "a"),
        ("tts", "a"),
        ("fit", "a"),
        ("shorten", "a"),
        ("tts", "a"),
        ("translation", "b"),
        ("tts", "b"),
    ]
    assert record.translations[0]["full_text"] == "Полный перевод."
    assert record.translations[0]["adapted_text"] == "Коротко."
    assert [a["fits"] for a in record.translations[0]["attempts"]] == [False, True]
    assert progress == sorted(progress)
    snapshots = [
        json.loads(wire.split("data: ", 1)[1])
        for _, wire in service.history[record.id]
        if "event: progress" in wire
    ]
    assert any(
        s["translations"][0].get("step") == "shorten"
        and s["stages"]["dubbing"]["completed_units"] == 0
        for s in snapshots
    )
    assert record.stages["dubbing"]["completed_units"] == 2
    # A second run reuses raw, unaccelerated clips. It never re-translates or re-synthesizes.
    operations.clear()
    for translation in record.translations:
        translation["status"] = "translated"
    record.status = "synthesizing"
    asyncio.run(service.render(record))
    assert operations == []
    assert record.status == "completed"
