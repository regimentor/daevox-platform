import asyncio
import json

from fastapi.testclient import TestClient
from test_voiceover_api import BASE, SOURCE, model_worker, video_bytes, wait_status

from transcription.api import create_app
from transcription.config import Settings
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_synthesis_progress_counts_complete_phrases_not_variants(tmp_path, monkeypatch):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="progress", source={"kind": "file"}, created_at="now", status="synthesizing"
    )
    observed = []

    async def worker(command, role, config, receive):
        for id in ["a", "a-alt", "b"]:
            receive({"kind": "synthesized", "id": id})
            observed.append(record.stages["synthesis"]["completed_units"])

    monkeypatch.setattr("transcription.voiceover.run_worker", worker)
    asyncio.run(
        service.phase(
            record,
            [],
            "tts",
            {
                "phrases": [
                    {"id": "a", "source_segment_ids": ["a"]},
                    {"id": "a-alt", "source_segment_ids": ["a"]},
                    {"id": "b", "source_segment_ids": ["b"]},
                ]
            },
            lambda event: None,
        )
    )
    assert observed == [0, 1, 2]
    assert record.stages["synthesis"]["total_units"] == 2
    assert record.stages["synthesis"]["elapsed_seconds"] > 0


def test_automatic_voiceover_and_revoice_without_recognition(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json={**SOURCE, "auto_synthesize": True}).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"completed", "failed"})
        assert ready["status"] == "completed", ready
        assert ready["elapsed_seconds"] > 0
        assert ready["processing_started_at"] is None
        assigned = client.put(
            f"{BASE}/voiceovers/{record['id']}/voices",
            json={
                "expected_revision": ready["revision"],
                "voice_assignments": {key: "baya" for key in ready["voice_assignments"]},
            },
        )
        assert assigned.status_code == 200
        response = client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={"expected_revision": assigned.json()["revision"], "client_request_id": "revoice"},
        )
        assert response.status_code == 202, response.text
        again = wait_status(client, record["id"], {"completed", "failed"})
        assert again["status"] == "completed", again
        assert again["elapsed_seconds"] > ready["elapsed_seconds"]
        assert again["transcript"] == ready["transcript"]
        events = [
            json.loads(line)
            for line in (tmp_path / "voiceovers" / record["id"] / "processing.jsonl")
            .read_text()
            .splitlines()
        ]
        assert sum(e["event"] == "worker.start" and e["role"] == "asr" for e in events) == 1


def test_gpu_choices_persist_and_unknown_gpu_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(
        Voiceovers,
        "devices",
        lambda self: [{"value": "GPU-a", "label": "A"}, {"value": "GPU-b", "label": "B"}],
    )
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert len(client.get(f"{BASE}/voiceover-devices").json()["items"]) == 2
        response = client.post(f"{BASE}/voiceovers", json={**SOURCE, "asr_gpu": "missing"})
        assert response.status_code == 422
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "asr_gpu": "GPU-a", "tts_gpu": "GPU-b"}
        ).json()
        assert record["devices"] == {
            "asr_gpu": "GPU-a",
            "diarization_gpu": "GPU-a",
            "tts_gpu": "GPU-b",
        }
