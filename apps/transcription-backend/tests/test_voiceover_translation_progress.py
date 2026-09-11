import asyncio
import json
import wave
from pathlib import Path

import pytest

from transcription.config import Settings
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_dubbing_prefetches_next_phrase_while_preserving_retry_and_cache(tmp_path, monkeypatch):
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
    translated_next = asyncio.Event()
    operations = []
    progress = []

    async def worker(command, role, config, receive):
        if role in {"translation", "tts", "shorten"}:
            assert len(config["phrases"]) == 1
            phrase = config["phrases"][0]
            operations.append((role, phrase["id"]))
        if role == "translation" and phrase["id"] == "b":
            translated_next.set()
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
            if phrase["id"] == "a":
                await asyncio.wait_for(translated_next.wait(), 2)
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
    assert [role for role, phrase_id in operations if phrase_id == "a"] == [
        "translation",
        "tts",
        "fit",
        "shorten",
        "tts",
    ]
    assert [role for role, phrase_id in operations if phrase_id == "b"] == ["translation", "tts"]
    assert operations.index(("translation", "b")) < operations.index(("fit", "a"))
    assert record.translations[0]["playback_end"] <= record.translations[1]["playback_start"]
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


@pytest.mark.parametrize("blocked_stage", ["tts", "fit"])
def test_stages_drain_all_phrases_while_next_stage_is_busy_and_cancel_cleanly(
    tmp_path, monkeypatch, blocked_stage
):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="bounded",
        created_at="2026-09-12T00:00:00Z",
        source={"kind": "file", "name": "test.mp4"},
        status="synthesizing",
        duration=16,
        transcript=[
            {
                "id": str(i),
                "start": i * 2,
                "end": i * 2 + 1,
                "text": f"Phrase {i}",
                "speaker_id": "one",
            }
            for i in range(8)
        ],
        voice_assignments={"one": "aidar"},
    )
    service.records[record.id] = record
    service.directory(record.id).mkdir(parents=True)

    async def check():
        all_translated = asyncio.Event()
        translating = []
        synthesis_cancelled = asyncio.Event()
        synthesized = []

        async def worker(command, role, config, receive):
            if role == blocked_stage:
                try:
                    await asyncio.Future()
                finally:
                    synthesis_cancelled.set()
            if role == "pauses":
                return
            phrase = config["phrases"][0]
            if role == "translation":
                translating.append(phrase["id"])
                receive({"kind": "translation", "id": phrase["id"], "text": phrase["text"]})
                if phrase["id"] == "7" and blocked_stage == "tts":
                    all_translated.set()
            elif role == "tts":
                path = Path(config["directory"]) / f"{phrase['id']}.wav"
                with wave.open(str(path), "wb") as audio:
                    audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                    audio.writeframes(b"\x01\x00" * 72000)
                receive(
                    {"kind": "synthesized", "id": phrase["id"], "path": str(path), "duration": 3}
                )
                synthesized.append(phrase["id"])
                if phrase["id"] == "7":
                    all_translated.set()

        monkeypatch.setattr("transcription.voiceover.run_worker", worker)
        task = asyncio.create_task(service.render(record))
        await asyncio.wait_for(all_translated.wait(), 2)
        assert translating == [str(i) for i in range(8)]
        if blocked_stage == "fit":
            assert synthesized == [str(i) for i in range(8)]
        assert record.dubbing["queue_mode"] == "stages"
        assert record.stages["dubbing"]["completed_units"] == 0
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert synthesis_cancelled.is_set()
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    asyncio.run(check())
