import asyncio

from test_voiceover_api import video_bytes

from transcription.config import Settings
from transcription.video_worker import render
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_real_render_reports_monotonic_audio_and_video_progress(tmp_path, monkeypatch):
    (tmp_path / "source").write_bytes(video_bytes(tmp_path))
    events = []
    monkeypatch.setattr(
        "transcription.video_worker.stage", lambda name, **event: events.append(event)
    )
    render({"directory": str(tmp_path), "duration": 3, "placements": []})
    values = [event["completed_units"] for event in events]
    assert values == sorted(values)
    assert values[0] == 0
    assert any(0 < value < 3 for value in values)
    assert any(3 < value < 6 for value in values)
    assert values[-1] == 6
    assert events[-1]["state"] == "completed"
    assert (tmp_path / "video.mp4").stat().st_size > 0


def test_render_progress_reaches_snapshot_and_library(tmp_path, monkeypatch):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="render", source={"kind": "file"}, created_at="now", status="synthesizing"
    )
    service.records[record.id] = record

    async def worker(command, role, config, receive):
        receive(
            {
                "kind": "stage",
                "name": "rendering",
                "state": "running",
                "completed_units": 3,
                "total_units": 6,
                "unit": "seconds",
            }
        )
        stage = service.library(None, 20)["items"][0]["stages"]["rendering"]
        assert stage["completed_units"] == 3
        assert stage["total_units"] == 6
        assert stage["state"] == "running"

    monkeypatch.setattr("transcription.voiceover.run_worker", worker)
    asyncio.run(service.phase(record, [], "render", {"duration": 3}, lambda event: None))
    assert record.stages["rendering"]["state"] == "completed"
