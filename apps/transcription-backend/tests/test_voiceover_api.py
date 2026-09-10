import pytest
from fastapi.testclient import TestClient

from transcription.api import create_app
from transcription.config import Settings

BASE = "/trancription-api"
SOURCE = {"source_kind": "file", "filename": "talk.mp4", "client_request_id": "first"}


def test_reserving_video_exposes_record_and_shared_activity(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        response = client.post(f"{BASE}/voiceovers", json=SOURCE)
        assert response.status_code == 201
        record = response.json()
        assert record["status"] == "awaiting_upload"
        assert client.get(f"{BASE}/voiceovers/{record['id']}").json() == record
        assert client.get(f"{BASE}/activity").json() == {
            "kind": "voiceover",
            "id": record["id"],
            "status": "awaiting_upload",
        }


def test_voiceover_and_transcription_share_one_slot(tmp_path):
    for first, second, kind, id_field in (
        ("voiceovers", "operations", "voiceover", "id"),
        ("operations", "voiceovers", "transcription", "operation_id"),
        ("voiceovers", "voiceovers", "voiceover", "id"),
    ):
        with TestClient(create_app(Settings(data_dir=tmp_path / f"{first}-{second}"))) as client:
            record = client.post(f"{BASE}/{first}", json=SOURCE).json()
            blocked = client.post(
                f"{BASE}/{second}", json={**SOURCE, "client_request_id": "second"}
            )
            assert blocked.status_code == 409
            assert blocked.json()["detail"]["active"] == {
                "kind": kind,
                "id": record[id_field],
                "status": "awaiting_upload",
            }
            assert client.get(f"{BASE}/activity").json() == blocked.json()["detail"]["active"]


def test_network_retries_return_record_but_reject_changed_source(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        retry = client.post(f"{BASE}/voiceovers", json=SOURCE)
        assert retry.status_code == 200
        assert retry.json() == record
        conflict = client.post(f"{BASE}/voiceovers", json={**SOURCE, "filename": "other.mp4"})
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "idempotency_conflict"


def test_restart_preserves_record_and_key_and_marks_interrupted_work(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        response = client.get(f"{BASE}/voiceovers/{record['id']}")
        assert response.status_code == 200
        restored = response.json()
        assert restored["status"] == "failed"
        assert restored["error"]["code"] == "interrupted"
        assert restored["revision"] > record["revision"]
        assert client.get(f"{BASE}/activity").json() is None
        assert client.post(f"{BASE}/voiceovers", json=SOURCE).json() == restored


def test_delete_releases_slot_and_old_key_cannot_recreate_record_after_restart(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        deleted = client.delete(f"{BASE}/voiceovers/{record['id']}")
        assert deleted.status_code == 204
        assert client.get(f"{BASE}/voiceovers/{record['id']}").status_code == 404
        assert client.get(f"{BASE}/activity").json() is None
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.post(f"{BASE}/voiceovers", json=SOURCE).status_code == 410
        assert (
            client.post(
                f"{BASE}/voiceovers", json={**SOURCE, "client_request_id": "fresh"}
            ).status_code
            == 201
        )


def test_library_pages_newest_first_without_full_text_or_local_paths(tmp_path):
    ids = []
    for index in range(3):
        with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
            record = client.post(
                f"{BASE}/voiceovers", json={**SOURCE, "client_request_id": str(index)}
            ).json()
            ids.append(record["id"])
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        response = client.get(f"{BASE}/voiceovers?limit=2")
        assert response.status_code == 200
        page = response.json()
        assert [item["id"] for item in page["items"]] == [ids[2], ids[1]]
        assert all("transcript" not in item for item in page["items"])
        assert str(tmp_path) not in response.text
        tail = client.get(
            f"{BASE}/voiceovers", params={"cursor": page["next_cursor"], "limit": 2}
        ).json()
        assert [item["id"] for item in tail["items"]] == [ids[0]]
        assert tail["next_cursor"] is None


def wait_status(client, record_id, statuses):
    import time

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        record = client.get(f"{BASE}/voiceovers/{record_id}").json()
        if record["status"] in statuses:
            return record
        time.sleep(0.01)
    raise AssertionError(f"Record did not reach {statuses}: {record}")


def test_invalid_uploaded_media_fails_visibly_and_releases_slot(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        response = client.put(f"{BASE}/voiceovers/{record['id']}/source", content=b"not video")
        assert response.status_code == 202
        failed = wait_status(client, record["id"], {"failed"})
        assert failed["error"]["code"] == "invalid_media"
        assert client.get(f"{BASE}/activity").json() is None


def test_failed_cleanup_remains_visible_and_can_be_retried(tmp_path, monkeypatch):
    import shutil

    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=b"not video")
        wait_status(client, record["id"], {"failed"})
        with monkeypatch.context() as patch:

            def cannot_remove(*args, **kwargs):
                raise PermissionError("denied")

            patch.setattr(shutil, "rmtree", cannot_remove)
            response = client.delete(f"{BASE}/voiceovers/{record['id']}")
            assert response.status_code == 409
            assert (
                client.get(f"{BASE}/voiceovers/{record['id']}").json()["status"] == "delete_failed"
            )
        assert client.delete(f"{BASE}/voiceovers/{record['id']}").status_code == 204


def model_worker():
    import sys
    from pathlib import Path

    return [sys.executable, str(Path(__file__).parent / "support/voiceover_worker.py")]


def video_bytes(tmp_path, duration=3):
    import subprocess

    video = tmp_path / "input.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=blue:s=160x90:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={duration}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-y",
            str(video),
        ],
        check=True,
    )
    return video.read_bytes()


def test_video_preparation_preserves_timed_text_and_waits_for_voice_confirmation(tmp_path):
    media = video_bytes(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        assert (
            client.put(f"{BASE}/voiceovers/{record['id']}/source", content=media).status_code == 202
        )
        ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
        assert ready["status"] == "awaiting_voices", ready
        assert [(s["text"], s["start"], s["end"]) for s in ready["transcript"]] == [
            ("Hello.", 0, 0.4),
            (" Goodbye.", 1, 1.5),
        ]
        assert [s["text"] for s in ready["translations"]] == ["Привет.", "До свидания."]
        assert [s["source_segment_ids"] for s in ready["translations"]] == [
            [ready["transcript"][0]["id"]],
            [ready["transcript"][1]["id"]],
        ]
        assert len(ready["voice_assignments"]) == 2
        assert ready["stages"]["preparation"]["state"] == "completed"
        assert ready["stages"]["translation"]["state"] == "completed"
        assert ready["stages"]["voice_samples"]["state"] == "completed"
        assert client.get(f"{BASE}/activity").json()["status"] == "awaiting_voices"


def test_voiceover_does_not_split_a_sentence_at_an_arbitrary_time_limit(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "whole-sentence.mp4"}
        ).json()
        client.put(
            f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path, duration=12)
        )
        ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
        assert ready["status"] == "awaiting_voices"
        assert [p["text"] for p in ready["transcript"]] == ["This is one sentence."]
        assert ready["transcript"][0]["end"] == 10


def test_words_with_zero_duration_do_not_create_impossible_voiceover_slots(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "zero-time-words.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
        assert [p["text"] for p in ready["transcript"]] == ["The code. Works. Well."]
        assert len(ready["transcript"][0]["words"]) == 3
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={"expected_revision": ready["revision"], "client_request_id": "synth"},
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"


def test_default_video_processing_uses_second_gpu(tmp_path):
    media = video_bytes(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "second-gpu.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=media)
        ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
        assert ready["status"] == "awaiting_voices", ready
        assert ready["stages"]["preparation"]["state"] == "completed"
        assert ready["stages"]["translation"]["state"] == "completed"
        assert ready["stages"]["voice_samples"]["state"] == "completed"
        assert client.get(f"{BASE}/activity").json()["status"] == "awaiting_voices"


def test_voice_assignment_requires_current_revision_and_known_voices(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        assignment = {speaker["id"]: "xenia" for speaker in ready["speakers"]}
        body = {"expected_revision": ready["revision"], "voice_assignments": assignment}
        response = client.put(f"{BASE}/voiceovers/{record['id']}/voices", json=body)
        assert response.status_code == 200
        assert response.json()["voice_assignments"] == assignment
        assert client.put(f"{BASE}/voiceovers/{record['id']}/voices", json=body).status_code == 409
        bad = {
            **body,
            "expected_revision": response.json()["revision"],
            "voice_assignments": {"bad": "bad"},
        }
        assert client.put(f"{BASE}/voiceovers/{record['id']}/voices", json=bad).status_code == 422


def test_confirmed_synthesis_produces_seekable_media_and_survives_restart(tmp_path):
    media = video_bytes(tmp_path)
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=media)
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        body = {"expected_revision": ready["revision"], "client_request_id": "synthesis"}
        response = client.post(f"{BASE}/voiceovers/{record['id']}/synthesize", json=body)
        assert response.status_code == 202
        complete = wait_status(client, record["id"], {"completed", "failed"})
        assert complete["status"] == "completed", complete
        assert [(p["playback_start"], p["playback_end"]) for p in complete["translations"]] == [
            (0, 0.25),
            (1, 1.25),
        ]
        assert (
            client.post(f"{BASE}/voiceovers/{record['id']}/synthesize", json=body).json()
            == complete
        )
        assert client.get(f"{BASE}/activity").json() is None
        published_bytes = sum(
            int(client.head(url).headers["content-length"]) for url in complete["assets"].values()
        )
        assert complete["storage_bytes"] == len(media) + published_bytes
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        replay = client.post(f"{BASE}/voiceovers/{record['id']}/synthesize", json=body)
        assert replay.status_code == 202
        assert replay.json() == complete
        for asset in ("video", "audio"):
            response = client.get(complete["assets"][asset], headers={"Range": "bytes=0-15"})
            assert response.status_code == 206
            assert len(response.content) == 16
            assert response.headers["content-range"].startswith("bytes 0-15/")


def test_long_speech_is_preserved_and_delays_the_next_phrase_without_overlap(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "too-long.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"
        assert result["problems"] == []
        assert result["translations"][0]["text"] == "Привет."
        first, second = result["translations"]
        assert first["status"] == second["status"] == "ready"
        assert 1 < first["playback_end"] < 1.3
        assert second["playback_start"] == first["playback_end"]
        assert client.get(result["assets"]["audio"]).status_code == 200


def test_sse_returns_current_snapshot_when_replay_history_is_unavailable(tmp_path):
    from test_api import parse_events

    with TestClient(create_app(Settings(data_dir=tmp_path, event_history=2))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=b"not video")
        failed = wait_status(client, record["id"], {"failed"})
        response = client.get(
            f"{BASE}/voiceovers/{record['id']}/events", headers={"Last-Event-ID": "0"}
        )
        assert response.status_code == 200
        assert parse_events(response) == [("snapshot", failed)]


def test_sse_replays_only_revisions_newer_than_cursor(tmp_path):
    from test_api import parse_events

    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=b"not video")
        failed = wait_status(client, record["id"], {"failed"})
        response = client.get(
            f"{BASE}/voiceovers/{record['id']}/events",
            headers={
                "Last-Event-ID": str(failed["revision"] - 1),
            },
        )
        assert parse_events(response) == [("state", failed)]


def test_all_five_voice_samples_are_ready_before_voice_selection(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        assert client.get(f"{BASE}/voiceover-voices/aidar/sample").status_code == 404
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        wait_status(client, record["id"], {"awaiting_voices"})
        for voice in ("aidar", "baya", "kseniya", "xenia", "eugene"):
            response = client.get(f"{BASE}/voiceover-voices/{voice}/sample")
            assert response.status_code == 200
            assert response.content.startswith(b"RIFF")
        client.delete(f"{BASE}/voiceovers/{record['id']}")
        assert client.head(f"{BASE}/voiceover-voices/aidar/sample").status_code == 200


def test_overlapping_speech_is_placed_sequentially_inside_its_group(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "overlap.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"
        assert [(t["playback_start"], t["playback_end"]) for t in result["translations"]] == [
            (0, 0.25),
            (0.25, 0.5),
        ]


def test_youtube_reservation_starts_acquisition_without_file_upload(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        url = "https://www.youtube.com/watch?v=abcdefghijk"
        response = client.post(
            f"{BASE}/voiceovers",
            json={
                "source_kind": "youtube",
                "url": url,
                "client_request_id": "youtube",
            },
        )
        assert response.status_code == 201
        record = response.json()
        assert record["status"] == "preparing"
        assert record["source"]["url"] == url
        ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
        assert ready["status"] == "awaiting_voices", ready


def test_restart_keeps_failed_active_cleanup_and_slot_until_retry(tmp_path, monkeypatch):
    import shutil

    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        wait_status(client, record["id"], {"awaiting_voices"})
        with monkeypatch.context() as patch:

            def cannot_remove(*args, **kwargs):
                raise PermissionError("denied")

            patch.setattr(shutil, "rmtree", cannot_remove)
            assert client.delete(f"{BASE}/voiceovers/{record['id']}").status_code == 409
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get(f"{BASE}/voiceovers/{record['id']}").json()["status"] == "delete_failed"
        assert client.get(f"{BASE}/activity").json()["id"] == record["id"]
        assert client.post(f"{BASE}/operations", json=SOURCE).status_code == 409
        assert client.delete(f"{BASE}/voiceovers/{record['id']}").status_code == 204
        assert client.get(f"{BASE}/activity").json() is None


def test_voiceover_rejects_playlist_requests_and_non_english_language(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        for body in (
            {**SOURCE, "language": "ru"},
            {
                "source_kind": "youtube",
                "client_request_id": "playlist",
                "url": "https://youtube.com/watch?v=abcdefghijk&list=xyz",
            },
        ):
            assert client.post(f"{BASE}/voiceovers", json=body).status_code == 422
        assert client.get(f"{BASE}/activity").json() is None


def test_moderate_acceleration_fits_speech_without_shifting_next_group(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json={**SOURCE, "filename": "fits.mp4"}).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"
        assert 0.9 < result["translations"][0]["playback_end"] <= 1
        assert result["translations"][1]["playback_start"] == 1


def test_long_translation_can_be_rephrased_before_becoming_problematic(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "rephrase.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"
        assert result["translations"][0]["text"] == "Привет!"
        assert result["translations"][0]["playback_end"] == 0.25


def test_retries_duration_feedback_before_dropping_a_translated_phrase(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "adaptive-fit.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={"expected_revision": ready["revision"], "client_request_id": "synth"},
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed", result["problems"]
        assert result["translations"][0]["text"] == "Здравствуй."
        assert all(t["status"] == "ready" for t in result["translations"])


def test_a_failed_translation_keeps_other_phrases_playable(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "translation-failure.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "incomplete"
        assert result["problems"][0]["reason"] == "translation_error"
        assert result["transcript"][0]["text"] == "Hello."
        assert result["translations"][1]["playback_start"] == 1


def test_a_failed_speech_fragment_keeps_other_groups_playable(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "tts-failure.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={
                "expected_revision": ready["revision"],
                "client_request_id": "synth",
            },
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "incomplete"
        assert result["problems"][0]["reason"] == "synthesis_error"
        assert result["translations"][0]["text"] == "Привет."
        assert result["translations"][1]["playback_start"] == 1


@pytest.mark.parametrize("fenced", [False, True])
def test_real_translation_adapter_reports_missing_phrase_without_losing_others(tmp_path, fenced):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            phrases = json.loads(body["messages"][-1]["content"])
            answer = {"translations": [{"id": phrases[-1]["id"], "text": "До свидания."}]}
            content = json.dumps(answer)
            if fenced:
                content = f"```json\n{content}\n```"
            wire = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        settings = Settings(
            data_dir=tmp_path,
            llm_model="translation-test-server",
            llm_base_url=f"http://127.0.0.1:{server.server_port}/v1",
        )
        with TestClient(create_app(settings, worker_command=model_worker())) as client:
            record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
            client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
            ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
            assert ready["status"] == "awaiting_voices", ready
            assert ready["translations"][0]["status"] == "failed"
            assert ready["translations"][1]["text"] == "До свидания."
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_model_resource_failure_is_reported_with_its_original_code(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "gpu-failure.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        failed = wait_status(client, record["id"], {"failed"})
        assert failed["error"]["code"] == "OutOfMemoryError"
        assert client.get(f"{BASE}/activity").json() is None


def test_transcript_is_visible_while_recognition_is_still_running(tmp_path):
    import time

    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json={**SOURCE, "filename": "live.mp4"}).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = client.get(f"{BASE}/voiceovers/{record['id']}").json()
            if current["transcript"]:
                break
            time.sleep(0.01)
        assert current["transcript"]
        assert current["status"] == "preparing"
        assert current["stages"]["asr"]["state"] == "running"
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        assert "".join(p["text"] for p in ready["transcript"]) == "Hello. Goodbye."


def test_long_transcript_is_translated_in_bounded_requests(tmp_path):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            phrases = json.loads(body["messages"][-1]["content"])
            if len(phrases) > 24:
                self.send_error(413)
                return
            answer = {"translations": [{"id": p["id"], "text": "Привет."} for p in phrases]}
            wire = json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        settings = Settings(
            data_dir=tmp_path,
            llm_model="translation-test-server",
            llm_base_url=f"http://127.0.0.1:{server.server_port}/v1",
        )
        with TestClient(create_app(settings, worker_command=model_worker())) as client:
            record = client.post(
                f"{BASE}/voiceovers", json={**SOURCE, "filename": "long-transcript.mp4"}
            ).json()
            client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
            ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
            assert ready["status"] == "awaiting_voices", ready
            assert len(ready["translations"]) == 60
            assert all(
                t["text"] == "Привет." and t["status"] == "translated"
                for t in ready["translations"]
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_concurrent_delete_retries_share_cleanup_and_do_not_resurrect_record(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        wait_status(client, record["id"], {"awaiting_voices"})
        with ThreadPoolExecutor(2) as pool:
            responses = list(
                pool.map(lambda _: client.delete(f"{BASE}/voiceovers/{record['id']}"), range(2))
            )
        assert [r.status_code for r in responses] == [204, 204]
        assert client.delete(f"{BASE}/voiceovers/{record['id']}").status_code == 204
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get(f"{BASE}/voiceovers/{record['id']}").status_code == 404


def test_translation_receives_available_speech_time_from_the_video(tmp_path):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    requests = []
    thinking_options = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            thinking_options.append(body.get("chat_template_kwargs", {}).get("enable_thinking"))
            phrases = json.loads(body["messages"][-1]["content"])
            requests.extend(phrases)
            answer = {"translations": [{"id": p["id"], "text": "Привет."} for p in phrases]}
            wire = json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        settings = Settings(
            data_dir=tmp_path,
            llm_model="translation-test-server",
            llm_base_url=f"http://127.0.0.1:{server.server_port}/v1",
        )
        with TestClient(create_app(settings, worker_command=model_worker())) as client:
            record = client.post(f"{BASE}/voiceovers", json=SOURCE).json()
            client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
            ready = wait_status(client, record["id"], {"awaiting_voices", "failed"})
            assert ready["status"] == "awaiting_voices"
            assert [p.get("available_seconds") for p in requests] == [1.0, 2.0]
            assert thinking_options == [False]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_last_spoken_words_remain_playable_when_voiceover_extends_past_video(tmp_path):
    import json
    import subprocess

    with TestClient(
        create_app(Settings(data_dir=tmp_path), worker_command=model_worker())
    ) as client:
        record = client.post(
            f"{BASE}/voiceovers", json={**SOURCE, "filename": "voiceover-tail.mp4"}
        ).json()
        client.put(f"{BASE}/voiceovers/{record['id']}/source", content=video_bytes(tmp_path))
        ready = wait_status(client, record["id"], {"awaiting_voices"})
        client.post(
            f"{BASE}/voiceovers/{record['id']}/synthesize",
            json={"expected_revision": ready["revision"], "client_request_id": "synth"},
        )
        result = wait_status(client, record["id"], {"completed", "incomplete", "failed"})
        assert result["status"] == "completed"
        last_word_end = result["translations"][-1]["playback_end"]
        assert result["duration"] >= last_word_end > 4
        for kind, url in result["assets"].items():
            media = tmp_path / f"download-{kind}.mp4"
            media.write_bytes(client.get(url).content)
            probe = json.loads(
                subprocess.check_output(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "json",
                        str(media),
                    ]
                )
            )
            assert float(probe["format"]["duration"]) >= last_word_end - 0.05
