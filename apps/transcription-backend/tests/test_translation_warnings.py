import io
import json

from transcription.voice_worker import translate


def test_audit_rejection_keeps_text_and_warns(monkeypatch):
    replies = iter(
        [
            {"translations": [{"id": "a", "text": "Что?", "candidates": ["Что?"]}]},
            {"approved": []},
        ]
    )
    monkeypatch.setattr(
        "transcription.voice_worker.urlopen",
        lambda *a, **kw: io.BytesIO(
            json.dumps({"choices": [{"message": {"content": json.dumps(next(replies))}}]}).encode()
        ),
    )
    events = []
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: events.append(event))
    translate(
        {
            "llm_model": "test",
            "llm_base_url": "http://test",
            "tts_engine": "qwen",
            "phrases": [{"id": "a", "text": "What?"}],
        }
    )
    result = [event for event in events if event["kind"] == "translation"][-1]
    assert result["text"] == "Что?"
    assert result["status"] == "warning"
    assert result["warnings"]


def test_number_and_term_mismatch_keeps_candidate(monkeypatch):
    reply = {"translations": [{"id": "a", "text": "Пять агентов.", "candidates": []}]}
    monkeypatch.setattr(
        "transcription.voice_worker.urlopen",
        lambda *a, **kw: io.BytesIO(
            json.dumps({"choices": [{"message": {"content": json.dumps(reply)}}]}).encode()
        ),
    )
    events = []
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: events.append(event))
    translate(
        {
            "llm_model": "test",
            "llm_base_url": "http://test",
            "tts_engine": "silero",
            "phrases": [{"id": "a", "text": "10 agents."}],
        }
    )
    result = [event for event in events if event["kind"] == "translation"][-1]
    assert result["text"] == "Пять агентов."
    assert result["warnings"]


def test_equivalent_number_formats_are_allowed():
    from transcription.dubbing import translation_warnings

    assert not translation_warnings("10,000 agents, 2.5 seconds", "10 000 агентов, 2,5 секунды", [])


def test_unavailable_audit_preserves_translation(monkeypatch):
    replies = iter(
        [
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"translations": [{"id": "a", "text": "Привет."}]}
                            )
                        }
                    }
                ]
            },
            {"choices": []},
        ]
    )
    monkeypatch.setattr(
        "transcription.voice_worker.urlopen",
        lambda *a, **kw: io.BytesIO(json.dumps(next(replies)).encode()),
    )
    events = []
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: events.append(event))
    translate(
        {
            "llm_model": "test",
            "llm_base_url": "http://test",
            "tts_engine": "qwen",
            "phrases": [{"id": "a", "text": "Hello."}],
        }
    )
    result = [event for event in events if event["kind"] == "translation"][-1]
    assert result["text"] == "Привет."
    assert result["warnings"][0]["code"] == "audit_unavailable"
    assert any(event.get("event") == "llm.request" for event in events)
    assert any(event.get("event") == "llm.response" for event in events)


def test_initial_translation_does_not_receive_a_speaking_time_limit(monkeypatch):
    captured = []

    def request(config, body, purpose):
        captured.append(body)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"translations": [{"id": "a", "text": "Полный перевод."}]}
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr("transcription.voice_worker.request_llm", request)
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: None)
    source = "First explain the design system. Then compare each alternative and explain its limitations."
    config = {
        "llm_model": "test",
        "tts_engine": "silero",
        "phrases": [{"id": "a", "text": source, "available_seconds": 1}],
    }
    translate(config)
    payload = json.loads(captured[-1]["messages"][-1]["content"])[0]
    assert payload["text"] == source
    assert "available_seconds" not in payload
    assert "13 Russian characters" not in captured[-1]["messages"][0]["content"]
    translate(
        {
            **config,
            "shorten": True,
            "target_duration": 1,
            "measured_duration": 30,
            "phrases": [{"id": "a", "text": "Полный перевод.", "original": source}],
        }
    )
    payload = json.loads(captured[-1]["messages"][-1]["content"])[0]
    assert payload["original"] == source
    assert payload["available_seconds"] == 1
    assert "return the complete translation unchanged" in captured[-1]["messages"][0]["content"]
