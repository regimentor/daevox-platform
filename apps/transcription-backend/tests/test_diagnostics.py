import asyncio
import json
import sys

from transcription.diagnostics import append_event
from transcription.processes import run_worker


def test_json_journal_masks_credentials_preserving_diagnostic_text(tmp_path):
    path = tmp_path / "processing.jsonl"
    append_event(
        path,
        "request",
        config={"hf_token": "private", "max_tokens": 100},
        raw=json.dumps({"api_key": "private", "text": "Привет"}),
        url="http://user:private@localhost/v1?token=private",
    )
    raw = path.read_text()
    event = json.loads(raw)
    assert "private" not in raw
    assert event["config"]["max_tokens"] == 100
    assert "Привет" in event["raw"]
    assert path.stat().st_mode & 0o777 == 0o600


def test_worker_journal_keeps_stderr_and_diagnostics_out_of_progress(tmp_path):
    path = tmp_path / "processing.jsonl"
    received = []
    script = 'import json,sys; print("trace detail",file=sys.stderr); print(json.dumps({"kind":"diagnostic","raw":"full response"})); print(json.dumps({"kind":"done"}))'
    asyncio.run(
        run_worker(
            [sys.executable, "-c", script], "test", {"diagnostic_path": str(path)}, received.append
        )
    )
    events = [json.loads(line) for line in path.read_text().splitlines()]
    assert received == [{"kind": "done"}]
    assert any(e["event"] == "worker.stderr" and "trace detail" in e["text"] for e in events)
    assert any(e.get("payload", {}).get("raw") == "full response" for e in events)
    assert events[-1]["event"] == "worker.exit"


def test_translation_exception_keeps_traceback_in_journal(tmp_path):
    import pytest

    from transcription.processes import WorkerFailure

    path = tmp_path / "processing.jsonl"
    with pytest.raises(WorkerFailure):
        asyncio.run(
            run_worker(
                [sys.executable, "-m", "transcription.voice_worker"],
                "translation",
                {"diagnostic_path": str(path), "llm_model": ""},
                lambda event: None,
            )
        )
    events = [json.loads(line) for line in path.read_text().splitlines()]
    detail = next(
        e["payload"] for e in events if e.get("payload", {}).get("event") == "worker.exception"
    )
    assert "Configure TRANSCRIPTION_LLM_MODEL" in detail["message"]
    assert "Traceback" in detail["traceback"]
