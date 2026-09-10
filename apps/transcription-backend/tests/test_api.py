import sys
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from transcription.api import create_app
from transcription.config import Settings

BASE = "/trancription-api"


def test_reservation_is_atomic_idempotent_and_does_not_load_models(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get(f"{BASE}/health").json() == {"status": "ok"}
        assert client.get(f"{BASE}/operations/current").json() is None

        def reserve(request_id):
            return client.post(
                f"{BASE}/operations",
                json={
                    "source_kind": "file",
                    "filename": "speech.wav",
                    "language": "ru",
                    "client_request_id": request_id,
                },
            )

        with ThreadPoolExecutor(2) as pool:
            responses = list(pool.map(reserve, ["first", "second"]))
        assert sorted(r.status_code for r in responses) == [201, 409]
        winner = next(r.json() for r in responses if r.status_code == 201)
        request_id = "first" if responses[0].status_code == 201 else "second"
        assert reserve(request_id).json() == winner
        assert winner["status"] == "awaiting_upload"
        assert not {"torch", "faster_whisper", "pyannote.audio"} & sys.modules.keys()


def terminal(client, operation_id, timeout=10):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = client.get(f"{BASE}/operations/{operation_id}").json()
        if snapshot.get("status") in {"completed", "cancelled", "failed"}:
            return snapshot
        time.sleep(0.01)
    raise AssertionError("operation did not finish")


def test_cancel_before_upload_saves_partial_result_and_releases_reservation(tmp_path):
    import json
    from pathlib import Path

    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        body = {"source_kind": "file", "filename": "../../speech.wav", "client_request_id": "one"}
        operation = client.post(f"{BASE}/operations", json=body).json()
        op_id = operation["operation_id"]
        assert client.post(f"{BASE}/operations/{op_id}/cancel").status_code == 202
        saved = terminal(client, op_id)
        assert saved["status"] == "cancelled"
        assert saved["completeness"] == {"asr": False, "diarization": False}
        document = json.loads(Path(saved["output_paths"]["json"]).read_text())
        assert document["segments"] == saved["segments"] == []
        assert document["status"] == "cancelled"
        assert "Неполный результат" in Path(saved["output_paths"]["txt"]).read_text()
        assert Path(saved["output_paths"]["txt"]).is_relative_to(tmp_path)
        assert client.post(f"{BASE}/operations/{op_id}/cancel").json() == saved
        assert (
            client.post(f"{BASE}/operations", json={**body, "client_request_id": "two"}).status_code
            == 201
        )


def test_uploaded_file_streams_text_and_saves_word_level_speakers(tmp_path):
    import json
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
        operation = client.post(
            f"{BASE}/operations",
            json={
                "source_kind": "file",
                "filename": "speech.wav",
                "client_request_id": "one",
            },
        ).json()
        op_id = operation["operation_id"]
        assert (
            client.put(f"{BASE}/operations/{op_id}/source", content=b"fake audio").status_code
            == 202
        )
        saved = terminal(client, op_id)
        assert saved["status"] == "completed", saved
        assert saved["completeness"] == {"asr": True, "diarization": True}
        assert [(s["text"], s["speaker_id"], s["overlap"]) for s in saved["segments"]] == [
            ("Привет,", "speaker_1", False),
            (" мир! Пока.", "speaker_2", True),
        ]
        document = json.loads(Path(saved["output_paths"]["json"]).read_text())
        assert document["segments"] == saved["segments"]
        assert document["speaker_turns"] == saved["speaker_turns"]
        assert not list((tmp_path / "tmp").glob("**/source"))
        assert (
            client.put(f"{BASE}/operations/{op_id}/source", content=b"duplicate").status_code == 409
        )


def parse_events(response):
    import json

    return [
        (block.split("event: ")[1].splitlines()[0], json.loads(block.split("data: ")[1]))
        for block in response.text.split("\n\n")
        if "data: " in block
    ]


def test_sse_replays_revisions_and_resets_when_history_is_lost(tmp_path):
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    with TestClient(
        create_app(Settings(data_dir=tmp_path, event_history=2), worker_command=worker)
    ) as client:
        op = client.post(
            f"{BASE}/operations",
            json={"source_kind": "file", "filename": "test.wav", "client_request_id": "sse"},
        ).json()
        op_id = op["operation_id"]
        client.put(f"{BASE}/operations/{op_id}/source", content=b"audio")
        saved = terminal(client, op_id)
        response = client.get(f"{BASE}/operations/{op_id}/events", headers={"Last-Event-ID": "1"})
        assert response.status_code == 200
        assert parse_events(response) == [("snapshot", saved)]
        tail = parse_events(
            client.get(
                f"{BASE}/operations/{op_id}/events",
                headers={"Last-Event-ID": str(saved["revision"] - 1)},
            )
        )
        assert tail == [("terminal", saved)]


def test_diarization_error_preserves_complete_asr(tmp_path):
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
        op = client.post(
            f"{BASE}/operations",
            json={
                "source_kind": "file",
                "filename": "diarization-error",
                "client_request_id": "error",
            },
        ).json()
        client.put(f"{BASE}/operations/{op['operation_id']}/source", content=b"audio")
        saved = terminal(client, op["operation_id"])
        assert saved["status"] == "failed"
        assert saved["completeness"] == {"asr": True, "diarization": False}
        assert "".join(s["text"] for s in saved["segments"]) == "Привет, мир! Пока."
        assert saved["error"]["code"] == "GatedRepoError"
        assert saved["output_paths"]["txt"]


def test_cancellation_stops_both_processes_and_preserves_received_text(tmp_path):
    import time
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
        op = client.post(
            f"{BASE}/operations",
            json={"source_kind": "file", "filename": "wait", "client_request_id": "cancel"},
        ).json()
        op_id = op["operation_id"]
        client.put(f"{BASE}/operations/{op_id}/source", content=b"audio")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = client.get(f"{BASE}/operations/{op_id}").json()
            if current["segments"] and current["stages"]["diarization"]["state"] == "running":
                break
            time.sleep(0.01)
        assert current["segments"]
        assert current["stages"]["diarization"]["state"] == "running"
        client.post(f"{BASE}/operations/{op_id}/cancel")
        saved = terminal(client, op_id)
        assert saved["status"] == "cancelled"
        assert saved["completeness"] == {"asr": False, "diarization": False}
        assert "".join(s["text"] for s in saved["segments"]) == "Привет, мир! Пока."
        assert saved["stages"]["asr"]["state"] == "cancelled"
        assert saved["stages"]["diarization"]["state"] == "cancelled"


def test_missing_upload_expires_and_storage_failure_is_not_success(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path, upload_timeout=0.02))) as client:
        op = client.post(
            f"{BASE}/operations",
            json={"source_kind": "file", "filename": "test", "client_request_id": "timeout"},
        ).json()
        saved = terminal(client, op["operation_id"])
        assert saved["status"] == "failed"
        assert saved["error"]["code"] == "upload_timeout"
    unusable = tmp_path / "not-a-directory"
    unusable.write_text("occupied")
    with TestClient(create_app(Settings(data_dir=unusable))) as client:
        op = client.post(
            f"{BASE}/operations",
            json={"source_kind": "file", "filename": "test", "client_request_id": "disk"},
        ).json()
        client.post(f"{BASE}/operations/{op['operation_id']}/cancel")
        saved = terminal(client, op["operation_id"])
        assert saved["status"] == "failed"
        assert saved["error"]["code"] == "storage_error"
        assert saved["output_paths"] == {}


def test_real_ffmpeg_prepares_audio_and_video_before_model_processes(tmp_path):
    import subprocess
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    for filename in ("real.wav", "real.mp4"):
        media = tmp_path / filename
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-y",
                str(media),
            ],
            check=True,
        )
        with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
            op = client.post(
                f"{BASE}/operations",
                json={"source_kind": "file", "filename": filename, "client_request_id": filename},
            ).json()
            client.put(f"{BASE}/operations/{op['operation_id']}/source", content=media.read_bytes())
            saved = terminal(client, op["operation_id"])
            assert saved["status"] == "completed", saved
            assert saved["stages"]["preparation"]["completed_units"] >= 1
            assert media.exists()


def test_invalid_sources_are_rejected_without_reserving_an_operation(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        for source in (
            {"source_kind": "file"},
            {"source_kind": "youtube", "url": "http://localhost/private"},
            {"source_kind": "youtube", "url": "https://youtube.com.evil.test/watch?v=x"},
            {"source_kind": "youtube", "url": "https://youtube.com/playlist?list=abc"},
        ):
            assert (
                client.post(
                    f"{BASE}/operations", json={**source, "client_request_id": "invalid"}
                ).status_code
                == 422
            )
            assert client.get(f"{BASE}/operations/current").json() is None


def test_result_name_handles_long_unicode_filenames(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        op = client.post(
            f"{BASE}/operations",
            json={
                "source_kind": "file",
                "filename": "音" * 100 + ".wav",
                "client_request_id": "unicode",
            },
        ).json()
        client.post(f"{BASE}/operations/{op['operation_id']}/cancel")
        saved = terminal(client, op["operation_id"])
        assert saved["status"] == "cancelled", saved["error"]
        assert set(saved["output_paths"]) == {"txt", "json"}


def test_cancel_during_disk_save_never_publishes_completed(tmp_path, monkeypatch):
    import os
    from pathlib import Path
    from threading import Event

    entered, release = Event(), Event()
    fsync = os.fsync

    def delayed_fsync(fd):
        if not entered.is_set():
            entered.set()
            assert release.wait(5)
        return fsync(fd)

    monkeypatch.setattr(os, "fsync", delayed_fsync)
    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
        op = client.post(
            f"{BASE}/operations",
            json={"source_kind": "file", "filename": "saving.wav", "client_request_id": "saving"},
        ).json()
        op_id = op["operation_id"]
        client.put(f"{BASE}/operations/{op_id}/source", content=b"audio")
        try:
            assert entered.wait(5)
            client.post(f"{BASE}/operations/{op_id}/cancel")
        finally:
            release.set()
        saved = terminal(client, op_id)
        events = parse_events(
            client.get(f"{BASE}/operations/{op_id}/events", headers={"Last-Event-ID": "1"})
        )
        assert [data["status"] for event, data in events if event == "terminal"] == ["cancelled"]
        assert saved["status"] == "cancelled"


def test_speaker_blocks_span_asr_batches_and_preserve_sse_and_exports(tmp_path):
    import json
    from pathlib import Path

    worker = [sys.executable, str(Path(__file__).parent / "support/worker.py")]
    for scenario in ("blocks-early", "blocks-late"):
        with TestClient(create_app(Settings(data_dir=tmp_path), worker_command=worker)) as client:
            op = client.post(
                f"{BASE}/operations",
                json={
                    "source_kind": "file",
                    "filename": scenario,
                    "client_request_id": scenario,
                },
            ).json()
            op_id = op["operation_id"]
            client.put(f"{BASE}/operations/{op_id}/source", content=b"audio")
            saved = terminal(client, op_id)
            assert saved["status"] == "completed"
            assert [
                (s["start"], s["end"], s["text"], s["speaker_id"], s["overlap"])
                for s in saved["segments"]
            ] == [
                (0, 1, "Привет,", "speaker_1", False),
                (1, 8, " мир! Пока. Продолжение.", "speaker_2", True),
                (8, 9, " Ответ.", "speaker_1", False),
            ]
            replayed = []
            for kind, event in parse_events(
                client.get(f"{BASE}/operations/{op_id}/events", headers={"Last-Event-ID": "1"})
            ):
                if kind == "transcript":
                    start = event["start_index"]
                    replayed[start : start + event["delete_count"]] = event["segments"]
            assert replayed == saved["segments"]
            assert (
                json.loads(Path(saved["output_paths"]["json"]).read_text())["segments"] == replayed
            )
            assert Path(saved["output_paths"]["txt"]).read_text().splitlines()[1:] == [
                "[00:00:00] Спикер 1: Привет,",
                "[00:00:01] Спикер 2 [Одновременная речь]: мир! Пока. Продолжение.",
                "[00:00:08] Спикер 1: Ответ.",
            ]
