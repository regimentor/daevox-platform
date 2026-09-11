import asyncio
import json

from transcription.config import Settings
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_each_translation_updates_progress_events_and_library(tmp_path, monkeypatch):
    observed = []

    async def worker(command, role, config, receive):
        if role == "voiceover_preparation":
            receive({"kind": "prepared", "path": "audio.wav", "duration": 3})
        elif role == "asr":
            receive(
                {
                    "kind": "words",
                    "words": [
                        {"start": 0, "end": 1, "text": "Hello."},
                        {"start": 1, "end": 2, "text": "Goodbye."},
                    ],
                }
            )
        elif role == "diarization":
            receive({"kind": "turns", "turns": [{"start": 0, "end": 3, "speaker_id": "A"}]})
        elif role == "translation":
            observed.append(dict(record.stages["translation"]))
            for phrase in config["phrases"]:
                receive({"kind": "translation", "id": phrase["id"], "text": "Перевод."})
                observed.append(
                    dict(service.library(None, 20)["items"][0]["stages"]["translation"])
                )

    monkeypatch.setattr("transcription.voiceover.run_worker", worker)
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="progress",
        created_at="2026-09-11T00:00:00Z",
        source={"kind": "file", "name": "test.mp4"},
        status="preparing",
    )
    service.records[record.id] = record
    asyncio.run(service.prepare(record))
    total = len(record.transcript)
    assert total > 0
    assert [entry["completed_units"] for entry in observed] == list(range(total + 1))
    assert all(
        entry.get("total_units") == total and entry["unit"] == "phrases" for entry in observed
    )
    progress = [
        json.loads(wire.split("data: ", 1)[1])
        for _, wire in service.history[record.id]
        if "event: progress" in wire
    ]
    assert any(
        value["stages"].get("translation", {}).get("completed_units") == total for value in progress
    )
