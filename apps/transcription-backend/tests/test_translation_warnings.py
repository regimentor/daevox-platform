import json

import pytest

from transcription.voice_worker import translate


@pytest.mark.parametrize("engine", ["silero", "qwen", "chatterbox", "cosyvoice"])
@pytest.mark.parametrize("text", ["Пять агентов.", "Do not translate", "Нет."])
def test_any_nonempty_result_is_accepted_without_audit(monkeypatch, engine, text):
    calls = []
    events = []

    def request(config, body, purpose):
        calls.append(purpose)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "translations": [
                                    {"id": "a", "text": text, "candidates": ["Другой вариант."]}
                                ]
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr("transcription.voice_worker.request_llm", request)
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: events.append(event))
    translate(
        {
            "llm_model": "test",
            "tts_engine": engine,
            "phrases": [{"id": "a", "text": "Rust needs 10 GPU cores."}],
        }
    )
    result = next(e for e in events if e["kind"] == "translation")
    assert calls == ["translation"]
    assert result["text"] == text
    assert result["status"] == "translated"
    assert result["warnings"] == []
    assert result["candidate_warnings"] == {}


@pytest.mark.parametrize("items", [[], [{"id": "a", "text": "   "}], [{"id": "a", "text": None}]])
def test_missing_result_is_retried_then_failed(monkeypatch, items):
    calls = []
    events = []

    def request(config, body, purpose):
        calls.append(purpose)
        return {"choices": [{"message": {"content": json.dumps({"translations": items})}}]}

    monkeypatch.setattr("transcription.voice_worker.request_llm", request)
    monkeypatch.setattr("transcription.voice_worker.emit", lambda **event: events.append(event))
    translate({"llm_model": "test", "phrases": [{"id": "a", "text": "Hello."}]})
    result = next(e for e in events if e["kind"] == "translation")
    assert calls == ["translation"] * 3
    assert result["status"] == "failed"
    assert result["warnings"][0]["code"] == "no_translation"


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
    assert "shortest faithful formulation" in captured[-1]["messages"][0]["content"]
    assert "materially more compact" in captured[-1]["messages"][0]["content"]
