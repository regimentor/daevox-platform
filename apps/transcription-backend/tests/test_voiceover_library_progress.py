from transcription.config import Settings
from transcription.voiceover import Voiceovers, VoiceoverSnapshot


def test_library_exposes_source_and_progress_without_transcripts(tmp_path):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="video-1",
        created_at="2026-09-11T00:00:00+00:00",
        source={"kind": "youtube", "url": "https://youtu.be/YE7VzlLtp-4", "name": "Video"},
        status="preparing",
        stages={
            "translation": {
                "state": "running",
                "completed_units": 2,
                "total_units": 5,
                "unit": "phrases",
            }
        },
        transcript=[{"text": "Full transcript"}],
    )
    service.records[record.id] = record
    item = service.library(None, 20)["items"][0]
    assert item["title"] == "Video"
    assert item["source"] == record.source
    assert item["stages"] == record.stages
    assert "transcript" not in item
    assert "translations" not in item


def test_library_has_a_useful_title_before_youtube_metadata_arrives(tmp_path):
    service = Voiceovers(Settings(data_dir=tmp_path))
    record = VoiceoverSnapshot(
        id="video-1",
        created_at="2026-09-11T00:00:00+00:00",
        source={"kind": "youtube", "url": "https://youtu.be/YE7VzlLtp-4"},
    )
    service.records[record.id] = record
    assert service.library(None, 20)["items"][0]["title"] == record.source["url"]
