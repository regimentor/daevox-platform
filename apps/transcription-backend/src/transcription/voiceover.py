import asyncio
import base64
import json
import logging
import shutil
import sqlite3
import subprocess
import sys
import time
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from starlette.requests import ClientDisconnect

from .alignment import align, normalize_turns
from .config import Settings
from .diagnostics import append_event
from .dubbing import semantic_windows
from .models import StartRequest, Turn
from .processes import WorkerFailure, run_worker


class VoiceoverRequest(StartRequest):
    language: Literal["en"] = "en"
    asr_gpu: str | None = None
    tts_gpu: str | None = None
    auto_synthesize: bool = False

    @model_validator(mode="after")
    def validate_video(self):
        if self.source_kind == "youtube" and "list" in parse_qs(urlparse(self.url or "").query):
            raise ValueError("Плейлисты не поддерживаются")
        return self


class VoiceAssignment(BaseModel):
    expected_revision: int
    voice_assignments: dict[str, str]


class SynthesisRequest(BaseModel):
    expected_revision: int
    client_request_id: str = Field(min_length=1, max_length=128)


class VoiceoverSnapshot(BaseModel):
    id: str
    revision: int = 1
    source: dict[str, str]
    created_at: str
    status: str = "awaiting_upload"
    stages: dict = Field(default_factory=dict)
    speakers: list = Field(default_factory=list)
    available_voices: list[str] = Field(default_factory=list)
    voice_assignments: dict = Field(default_factory=dict)
    transcript: list = Field(default_factory=list)
    translations: list = Field(default_factory=list)
    problems: list = Field(default_factory=list)
    assets: dict = Field(default_factory=dict)
    storage_bytes: int = 0
    error: dict | None = None
    duration: float | None = None
    source_duration: float | None = None
    devices: dict[str, str] = Field(default_factory=dict)
    auto_synthesize: bool = False
    elapsed_seconds: float = 0
    processing_started_at: float | None = None


class Voiceovers:
    def __init__(self, settings: Settings, worker_command: list[str] | None = None):
        self.settings = settings
        self.command = worker_command or [sys.executable, "-m", "transcription.worker"]
        self.translation_command = worker_command or [
            sys.executable,
            "-m",
            "transcription.voice_worker",
        ]
        self.voices = (
            ["serena", "aiden", "uncle_fu"]
            if settings.tts_engine == "qwen"
            else ["aidar", "baya", "kseniya", "xenia", "eugene"]
        )
        self.tts_command = worker_command or (
            [
                str(Path(settings.qwen_python).absolute()),
                str(Path(__file__).with_name("qwen_worker.py")),
            ]
            if settings.tts_engine == "qwen"
            else self.translation_command
        )
        import hashlib

        self.sample_key = hashlib.sha256(
            json.dumps(
                {
                    "engine": settings.tts_engine,
                    "model": settings.qwen_model_path
                    if settings.tts_engine == "qwen"
                    else settings.silero_sha256,
                    "instruction": settings.qwen_instruction,
                }
            ).encode()
        ).hexdigest()
        self.video_command = worker_command or [sys.executable, "-m", "transcription.video_worker"]
        self.database = settings.data_dir / "voiceovers.sqlite3"
        self.records: dict[str, VoiceoverSnapshot] = {}
        self.active: str | None = None
        self.requests: dict[str, tuple[dict, str]] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.deletions: dict[str, asyncio.Task] = {}
        self.uploads: set[str] = set()
        self.syntheses: dict[str, dict] = {}
        self.history: dict[str, deque[tuple[int, str]]] = {}
        if self.database.is_file():
            with sqlite3.connect(self.database) as db:
                stored = list(db.execute("SELECT id, payload FROM records"))
                self.records = {
                    key: VoiceoverSnapshot.model_validate_json(payload) for key, payload in stored
                }
                held = {key for key, payload in stored if json.loads(payload).get("_held_slot")}
                self.requests = {
                    key: (json.loads(payload), record_id)
                    for key, payload, record_id in db.execute(
                        "SELECT key, payload, id FROM requests"
                    )
                }
                db.execute(
                    "CREATE TABLE IF NOT EXISTS syntheses (id TEXT PRIMARY KEY, payload TEXT)"
                )
                self.syntheses = {
                    key: json.loads(payload)
                    for key, payload in db.execute("SELECT id, payload FROM syntheses")
                }
            for record in self.records.values():
                if record.status in {"deleting", "delete_failed"}:
                    if record.id in held:
                        self.active = record.id
                    record.status = "delete_failed"
                    record.error = {
                        "code": "cleanup_error",
                        "message": "Требуется повторная очистка",
                    }
                    record.revision += 1
                    self.save(record)
                elif record.status not in {"completed", "incomplete", "failed"}:
                    record.status = "failed"
                    record.error = {"code": "interrupted", "message": "Обработка прервана"}
                    record.revision += 1
                    self.save(record)

    def save(
        self, record: VoiceoverSnapshot, body: StartRequest | None = None, kind: str = "state"
    ):
        try:
            self.database.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.database) as db:
                db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT)")
                db.execute(
                    "CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, payload TEXT, id TEXT)"
                )
                db.execute(
                    "CREATE TABLE IF NOT EXISTS syntheses (id TEXT PRIMARY KEY, payload TEXT)"
                )
                db.execute(
                    "INSERT OR REPLACE INTO records VALUES (?, ?)",
                    (
                        record.id,
                        json.dumps({**record.model_dump(), "_held_slot": self.active == record.id}),
                    ),
                )
                if body:
                    db.execute(
                        "INSERT INTO requests VALUES (?, ?, ?)",
                        (body.client_request_id, body.model_dump_json(), record.id),
                    )
                if record.id in self.syntheses:
                    db.execute(
                        "INSERT OR REPLACE INTO syntheses VALUES (?, ?)",
                        (record.id, json.dumps(self.syntheses[record.id])),
                    )
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(
                507, {"code": "storage_error", "message": "Ошибка хранения записи"}
            ) from exc
        if record.status != "deleting":
            append_event(
                self.directory(record.id) / "processing.jsonl",
                "record.snapshot",
                record=record.model_dump(),
                notification=kind,
            )
        history = self.history.setdefault(record.id, deque(maxlen=self.settings.event_history))
        history.append((record.revision, self.wire(record, kind)))
        while len(history) > 1 and sum(len(wire.encode()) for _, wire in history) > 4 * 1024 * 1024:
            history.popleft()

    def retry(self, body: StartRequest) -> VoiceoverSnapshot | None:
        previous = self.requests.get(body.client_request_id)
        if previous is None:
            return None
        payload, record_id = previous
        if record_id not in self.records:
            raise HTTPException(410, {"code": "deleted", "message": "Запись удалена"})
        if payload != body.model_dump():
            raise HTTPException(409, {"code": "idempotency_conflict"})
        return self.get(record_id)

    async def delete(self, record_id: str):
        if record_id not in self.records and any(
            previous_id == record_id for _, previous_id in self.requests.values()
        ):
            return
        self.get(record_id)
        task = self.deletions.get(record_id)
        if task is None:
            task = asyncio.create_task(self._delete(record_id))
            self.deletions[record_id] = task
        try:
            await asyncio.shield(task)
        finally:
            if task.done():
                self.deletions.pop(record_id, None)

    async def _delete(self, record_id: str):
        record = self.get(record_id)
        record.status = "deleting"
        record.revision += 1
        self.save(record)
        task = self.tasks.get(record_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        while record_id in self.uploads:
            await asyncio.sleep(0.01)
        try:
            directory = self.directory(record_id)
            if directory.exists():
                await asyncio.to_thread(shutil.rmtree, directory)
            with sqlite3.connect(self.database) as db:
                db.execute("DELETE FROM records WHERE id = ?", (record_id,))
                db.execute("UPDATE requests SET payload = '{}' WHERE id = ?", (record_id,))
                db.execute("DELETE FROM syntheses WHERE id = ?", (record_id,))
        except (OSError, sqlite3.Error) as exc:
            record.status = "delete_failed"
            record.error = {"code": "cleanup_error", "message": "Не удалось удалить файлы"}
            record.revision += 1
            self.save(record)
            raise HTTPException(409, {"code": "cleanup_error"}) from exc
        del self.records[record_id]
        self.tasks.pop(record_id, None)
        self.history.pop(record_id, None)
        self.syntheses.pop(record_id, None)
        for key, (_, previous_id) in self.requests.items():
            if previous_id == record_id:
                self.requests[key] = ({}, record_id)
        if self.active == record_id:
            self.active = None

    def get(self, record_id: str) -> VoiceoverSnapshot:
        if record_id not in self.records:
            raise HTTPException(404, "Запись не найдена")
        return self.records[record_id]

    @staticmethod
    def wire(record: VoiceoverSnapshot, kind: str) -> str:
        return f"id: {record.revision}\nevent: {kind}\ndata: {record.model_dump_json()}\n\n"

    async def events(self, record_id: str, cursor: int | None):
        revision = cursor if cursor is not None else -1
        while record_id in self.records:
            record = self.get(record_id)
            if revision != record.revision:
                history = self.history.get(record_id, deque())
                if (
                    revision < 0
                    or revision > record.revision
                    or not history
                    or revision < history[0][0] - 1
                ):
                    yield self.wire(record, "snapshot")
                else:
                    for item_revision, wire in list(history):
                        if item_revision > revision:
                            yield wire
                revision = record.revision
            if record.status in {"completed", "incomplete", "failed", "delete_failed"}:
                return
            await asyncio.sleep(0.1)
        yield f'id: {revision + 1}\nevent: deleted\ndata: {{"id": "{record_id}", "revision": {revision + 1}}}\n\n'

    async def close(self):
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await asyncio.gather(*self.deletions.values(), return_exceptions=True)

    def directory(self, record_id: str) -> Path:
        return self.database.parent / "voiceovers" / record_id

    @staticmethod
    def stop_clock(record):
        if record.processing_started_at is not None:
            record.elapsed_seconds += max(0, time.time() - record.processing_started_at)
            record.processing_started_at = None

    def devices(self):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=uuid,name", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                check=True,
                timeout=3,
            )
            return [
                {
                    "value": parts[0].strip(),
                    "label": parts[1].strip() + " · " + parts[0].strip()[-8:],
                }
                for line in result.stdout.splitlines()
                if len(parts := line.split(",", 1)) == 2
            ]
        except (OSError, subprocess.SubprocessError):
            return []

    def fail(self, record: VoiceoverSnapshot, code: str, message: str):
        self.stop_clock(record)
        for stage in record.stages.values():
            if stage.get("started_at"):
                stage["elapsed_seconds"] = stage.get("elapsed_seconds", 0) + max(
                    0, time.time() - stage["started_at"]
                )
                stage.update(started_at=None, finished_at=time.time(), state="failed")
        record.status = "failed"
        record.error = {"code": code, "message": message}
        failed_stages = [
            key for key, stage in record.stages.items() if stage.get("state") == "failed"
        ]
        logging.getLogger(__name__).error(
            message,
            extra={"operation_id": record.id, "stage": ",".join(failed_stages), "code": code},
        )
        record.revision += 1
        self.save(record)
        if self.active == record.id:
            self.active = None

    async def upload(self, record_id: str, request: Request) -> VoiceoverSnapshot:
        record = self.get(record_id)
        if record.status != "awaiting_upload" or record_id in self.uploads:
            raise HTTPException(409, "Передача файла уже началась")
        self.uploads.add(record_id)
        try:
            directory = self.directory(record_id)
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / "source").open("wb") as output:
                iterator = request.stream().__aiter__()
                while record.status != "deleting":
                    incoming = asyncio.create_task(anext(iterator, None))
                    try:
                        while not incoming.done() and record.status != "deleting":
                            await asyncio.wait({incoming}, timeout=0.1)
                        if record.status == "deleting":
                            return record
                        chunk = incoming.result()
                        if chunk is None:
                            break
                        await asyncio.to_thread(output.write, chunk)
                        record.storage_bytes += len(chunk)
                    finally:
                        if not incoming.done():
                            incoming.cancel()
                        await asyncio.gather(incoming, return_exceptions=True)
            record.status = "preparing"
            record.revision += 1
            self.save(record)
            self.tasks[record_id] = asyncio.create_task(self.prepare(record))
        except (OSError, ClientDisconnect, HTTPException):
            if record.status != "deleting":
                self.fail(record, "upload_error", "Не удалось передать видео")
        finally:
            self.uploads.discard(record_id)
        return record

    async def phase(self, record, command, role, config, receive, *, stage_name=None):
        name = stage_name or {
            "voiceover_preparation": "preparation",
            "tts": "synthesis",
            "render": "rendering",
        }.get(role, role)
        started = time.monotonic()
        previous_elapsed = record.stages.get(name, {}).get("elapsed_seconds", 0)
        started_at = time.time()
        first_started_at = record.stages.get(name, {}).get("first_started_at", started_at)
        record.stages[name] = {
            "state": "running",
            "completed_units": 0,
            "unit": "",
            "started_at": started_at,
            "first_started_at": first_started_at,
            "elapsed_seconds": previous_elapsed,
        }
        phrase_groups: dict[tuple, set[str]] = {}
        if role == "tts":
            for phrase in config["phrases"]:
                owner = tuple(phrase.get("source_segment_ids") or [phrase["id"]])
                phrase_groups.setdefault(owner, set()).add(phrase["id"])
            record.stages[name].update(total_units=len(phrase_groups), unit="phrases")
        synthesized = set()

        def tracked(event):
            if event["kind"] == "stage":
                key = event["name"]
                prior = record.stages.get(key, {})
                event = {
                    **event,
                    "started_at": prior.get("started_at") or time.time(),
                    "first_started_at": prior.get("first_started_at", time.time()),
                    "elapsed_seconds": prior.get("elapsed_seconds", 0),
                }
                if event.get("state") != "running":
                    event["elapsed_seconds"] += time.time() - event["started_at"]
                    event["started_at"] = None
                    event["finished_at"] = time.time()
            if role == "render" and event["kind"] == "stage" and event["name"] == name:
                record.stages[name].update(
                    {
                        key: value
                        for key, value in event.items()
                        if key not in {"kind", "name", "state"}
                    }
                )
                record.revision += 1
                self.save(record, kind="progress")
            receive(event)
            if role == "tts" and event["kind"] == "synthesized":
                synthesized.add(event["id"])
                record.stages[name]["completed_units"] = sum(
                    ids <= synthesized for ids in phrase_groups.values()
                )
                record.revision += 1
                self.save(record, kind="progress")

        if role == "render":
            record.stages[name].update(
                total_units=max(float(config["duration"]) * 2, 0.001), unit="seconds"
            )
        if name == "translation":
            record.stages[name].update(total_units=len(config["phrases"]), unit="phrases")
        record.revision += 1
        self.save(record, kind="progress")
        state = "failed"
        try:
            await run_worker(
                command,
                role,
                {
                    **config,
                    "operation_id": record.id,
                    "diagnostic_path": str(self.directory(record.id) / "processing.jsonl"),
                },
                tracked,
            )
            state = "completed"
        finally:
            if record.status not in {"deleting", "delete_failed"}:
                record.stages[name].update(
                    state=state,
                    elapsed_seconds=previous_elapsed + time.monotonic() - started,
                    started_at=None,
                    finished_at=time.time(),
                )
                record.revision += 1
                self.save(record, kind="progress")

    async def prepare(self, record: VoiceoverSnapshot):
        record.processing_started_at = time.time()
        self.directory(record.id).mkdir(parents=True, exist_ok=True)
        config = {
            **self.settings.model_dump(mode="json"),
            **record.devices,
            "directory": str(self.directory(record.id)),
            "source_path": str(self.directory(record.id) / "source"),
            "source": record.source,
            "language": "en",
            "voiceover": True,
        }
        words: list[dict] = []
        raw_turns: list[dict] = []

        def project(final=False):
            turns, speakers = normalize_turns([Turn.model_validate(t) for t in raw_turns])
            # Keep phrase timing separate from the standalone transcription's speaker blocks.
            phrases: list[dict] = []
            for index, word in enumerate(words):
                segments = align([word], turns, final or bool(raw_turns), str(index))
                for segment in segments:
                    if segment.end <= segment.start:
                        point_speakers = {
                            turn.speaker_id
                            for turn in turns
                            if turn.start <= segment.start < turn.end
                        }
                        if len(point_speakers) == 1:
                            segment.speaker_id = next(iter(point_speakers))
                            segment.speaker_status = "assigned"
                    if (
                        phrases
                        and phrases[-1]["speaker_id"] == segment.speaker_id
                        and (
                            not phrases[-1]["text"].rstrip().endswith((".", "!", "?", ";", ":"))
                            or (
                                segment.end <= segment.start
                                and segment.start - phrases[-1]["end"] <= 0.5
                            )
                        )
                    ):
                        phrases[-1]["text"] += segment.text
                        phrases[-1]["end"] = max(phrases[-1]["end"], segment.end)
                        phrases[-1]["words"].append(word)
                        phrases[-1]["overlap"] |= segment.overlap
                    else:
                        phrases.append({**segment.model_dump(), "words": [word]})
            phrases = semantic_windows(phrases)
            record.transcript = phrases
            record.speakers = [speaker.model_dump() for speaker in speakers]
            voices = self.voices
            record.available_voices = voices
            record.voice_assignments = {
                s.id: voices[i % len(voices)] for i, s in enumerate(speakers)
            }
            if any(p["speaker_id"] is None for p in phrases):
                record.voice_assignments["unknown"] = voices[0]
            record.revision += 1
            self.save(record, kind="transcript")
            return voices

        def receive(event):
            if event["kind"] == "source_metadata":
                record.source["name"] = event["title"]
                record.revision += 1
                self.save(record)
            elif event["kind"] == "prepared":
                config.update(audio_path=event["path"], duration=event["duration"])
                record.duration = event["duration"]
            elif event["kind"] == "words":
                words.extend(event["words"])
                project()
            elif event["kind"] == "turns":
                raw_turns[:] = event["turns"]
                project()
            elif event["kind"] == "stage":
                record.stages[event["name"]] = {
                    k: v for k, v in event.items() if k not in {"kind", "name"}
                }
                record.revision += 1
                self.save(record)
            elif event["kind"] == "translation":
                phrase = next(p for p in config["phrases"] if p["id"] == event["id"])
                record.translations.append(
                    {
                        "id": phrase["id"],
                        "source_segment_ids": [phrase["id"]],
                        "text": event["text"],
                        "candidates": event.get("candidates", [event["text"]]),
                        "status": event.get("status", "translated"),
                        "warnings": event.get("warnings", []),
                        "candidate_warnings": event.get("candidate_warnings", {}),
                    }
                )
                record.stages["translation"].update(
                    completed_units=len({item["id"] for item in record.translations}),
                    total_units=len(config["phrases"]),
                    unit="phrases",
                )
                record.revision += 1
                self.save(record, kind="progress")

        try:
            await self.phase(
                record,
                self.video_command,
                "voiceover_preparation",
                config,
                receive,
            )
            async with asyncio.TaskGroup() as group:
                for role in ("asr", "diarization"):
                    group.create_task(self.phase(record, self.command, role, config, receive))
            if not words:
                self.fail(record, "no_speech", "Распознаваемой речи нет — озвучивать нечего")
                return
            voices = project(final=True)
            config["phrases"] = [
                {
                    **phrase,
                    "available_seconds": max(
                        0,
                        (
                            record.transcript[index + 1]["start"]
                            if index + 1 < len(record.transcript)
                            else record.duration
                        )
                        - phrase["start"],
                    ),
                }
                for index, phrase in enumerate(record.transcript)
            ]
            await self.phase(record, self.translation_command, "translation", config, receive)
            sample_directory = self.database.parent / "voice-samples" / self.sample_key
            sample_directory.mkdir(parents=True, exist_ok=True)
            samples = [
                {
                    "id": voice,
                    "voice": voice,
                    "text": "Здравствуйте. Это пример голоса для перевода видео.",
                }
                for voice in voices
                if not (sample_directory / f"{voice}.wav").is_file()
            ]
            if samples:
                await self.phase(
                    record,
                    self.tts_command,
                    "tts",
                    {
                        **config,
                        "directory": str(sample_directory),
                        "phrases": samples,
                    },
                    lambda event: None,
                    stage_name="voice_samples",
                )
            else:
                record.stages["voice_samples"] = {
                    "state": "completed",
                    "completed_units": 5,
                    "total_units": 5,
                    "unit": "voices",
                }
            record.source_duration = record.duration
            self.stop_clock(record)
            record.status = "awaiting_voices"
            record.revision += 1
            self.save(record)
            if record.auto_synthesize:
                record.status = "synthesizing"
                record.revision += 1
                self.save(record)
                await self.render(record)
        except ExceptionGroup as errors:
            cause = errors.exceptions[0]
            code = str(cause) if isinstance(cause, WorkerFailure) else type(cause).__name__
            self.fail(
                record,
                code,
                (cause.message if isinstance(cause, WorkerFailure) else None)
                or "Не удалось распознать речь и спикеров. Проверьте доступ к моделям и ресурсы GPU.",
            )
        except (WorkerFailure, OSError, ValueError) as error:
            self.fail(
                record,
                str(error) if isinstance(error, WorkerFailure) else type(error).__name__,
                (error.message if isinstance(error, WorkerFailure) else None)
                or "Не удалось подготовить видео, перевод или образцы голосов. Проверьте источник и настройки моделей.",
            )

    def activity(self) -> dict | None:
        if self.active is None:
            return None
        record = self.get(self.active)
        return {"kind": "voiceover", "id": record.id, "status": record.status}

    def synthesize(self, record_id: str, body: SynthesisRequest) -> VoiceoverSnapshot:
        record = self.get(record_id)
        if (
            record_id in self.syntheses
            and self.syntheses[record_id]["client_request_id"] == body.client_request_id
        ):
            if self.syntheses[record_id] != body.model_dump():
                raise HTTPException(409, {"code": "idempotency_conflict"})
            return record
        if (
            record.status not in {"awaiting_voices", "completed", "incomplete"}
            or record.revision != body.expected_revision
        ):
            raise HTTPException(409, {"code": "revision_conflict", "snapshot": record.model_dump()})
        if self.active not in {None, record_id}:
            raise HTTPException(409, {"code": "busy", "message": "Сервис занят"})
        self.active = record_id
        record.problems = []
        record.error = None
        record.assets = {}
        record.duration = record.source_duration or record.duration
        for key in ("synthesis", "shorten", "fit", "pauses", "rendering"):
            record.stages.pop(key, None)
        self.syntheses[record_id] = body.model_dump()
        record.status = "synthesizing"
        record.revision += 1
        self.save(record)
        self.tasks[record_id] = asyncio.create_task(self.render(record))
        return record

    async def render(self, record: VoiceoverSnapshot):
        record.processing_started_at = time.time()
        config = {
            **self.settings.model_dump(mode="json"),
            **record.devices,
            "directory": str(self.directory(record.id)),
            "source": record.source,
            "duration": record.duration,
            "phrases": [
                {
                    **translation,
                    "voice": record.voice_assignments[phrase["speaker_id"] or "unknown"],
                }
                for translation, phrase in zip(record.translations, record.transcript)
                if translation["status"] != "failed"
            ],
        }
        clips = {}

        def receive(event):
            if event["kind"] == "synthesized":
                clips[event["id"]] = event

        try:
            alternatives = []
            candidate_owners = {}
            for phrase in config["phrases"]:
                for index, text in enumerate(phrase.get("candidates", [phrase["text"]])):
                    key = phrase["id"] if index == 0 else f"{phrase['id']}-candidate-{index}"
                    alternatives.append({**phrase, "id": key, "text": text})
                    candidate_owners[key] = (phrase["id"], text)
                    if self.settings.tts_engine == "qwen" and self.settings.qwen_pace_instruction:
                        paced_key = key + "-brisk"
                        alternatives.append(
                            {
                                **phrase,
                                "id": paced_key,
                                "text": text,
                                "instruction": self.settings.qwen_pace_instruction,
                            }
                        )
                        candidate_owners[paced_key] = (phrase["id"], text)
            measured = {}

            def receive_alternative(event):
                if event["kind"] == "synthesized":
                    measured[event["id"]] = event

            await self.phase(
                record,
                self.tts_command,
                "tts",
                {**config, "phrases": alternatives},
                receive_alternative,
            )
            await self.phase(
                record,
                [sys.executable, "-m", "transcription.video_worker"],
                "pauses",
                {"clips": list(measured.values())},
                receive_alternative,
            )
            for key, clip in measured.items():
                owner, text = candidate_owners[key]
                translation = next(t for t in record.translations if t["id"] == owner)
                warnings = translation.get("candidate_warnings", {}).get(
                    text, translation.get("warnings", [])
                )
                if owner not in clips or (len(warnings), clip["duration"]) < (
                    len(translation.get("warnings", [])),
                    clips[owner]["duration"],
                ):
                    clips[owner] = {**clip, "id": owner}
                    translation["text"] = text
                    translation["warnings"] = warnings
                    translation["status"] = "warning" if translation["warnings"] else "translated"
            placements = []
            playback_cursor = 0.0
            groups: list[list[tuple[dict, dict]]] = []
            end = -1.0
            for phrase, translation in zip(record.transcript, record.translations):
                if not groups or phrase["start"] >= end:
                    groups.append([])
                    end = phrase["end"]
                groups[-1].append((phrase, translation))
                end = max(end, phrase["end"])
            for index, group in enumerate(groups):
                anchor = group[0][0]["start"]
                start = max(anchor, playback_cursor)
                end = max(phrase["end"] for phrase, _ in group)
                deadline = (
                    groups[index + 1][0][0]["start"]
                    if index + 1 < len(groups)
                    else (record.duration or 0.0)
                )
                if any(t["status"] == "failed" for _, t in group):
                    record.problems.append(
                        {"start": start, "end": end, "reason": "translation_error"}
                    )
                    continue
                if any(t["id"] not in clips for _, t in group):
                    for _, translation in group:
                        translation["status"] = "failed"
                    record.problems.append(
                        {"start": start, "end": end, "reason": "synthesis_error"}
                    )
                    continue
                total = sum(clips[translation["id"]]["duration"] for _, translation in group)
                available = max(0.05, deadline - start)
                speech_budget = max(
                    0.05, min(deadline - anchor, deadline + self.settings.voiceover_max_lag - start)
                )
                rephrased: dict[str, str] = {}
                rephrased_warnings: dict[str, list] = {}
                for attempt in range(3):
                    if total / speech_budget <= 1.15:
                        break
                    candidate_text: dict[str, str] = {}
                    candidate_warnings: dict[str, list] = {}

                    def revised(
                        event,
                        group=group,
                        candidate_text=candidate_text,
                        candidate_warnings=candidate_warnings,
                    ):
                        if (
                            event["kind"] == "translation"
                            and event["id"] in {t["id"] for _, t in group}
                            and event.get("status") != "failed"
                            and event.get("text", "").strip()
                        ):
                            candidate_text[event["id"]] = event["text"]
                            candidate_warnings[event["id"]] = event.get("warnings", [])

                    try:
                        await self.phase(
                            record,
                            self.translation_command,
                            "shorten",
                            {
                                **config,
                                "target_duration": speech_budget,
                                "measured_duration": total,
                                "phrases": [
                                    {
                                        **t,
                                        "text": rephrased.get(t["id"], t["text"]),
                                        "original": p["text"],
                                    }
                                    for p, t in group
                                ],
                            },
                            revised,
                        )
                        if len(candidate_text) == len(group):
                            candidate_clips: dict[str, dict] = {}
                            candidate_directory = (
                                self.directory(record.id) / f"fit-{index}-{attempt}"
                            )
                            candidate_directory.mkdir(exist_ok=True)

                            def receive_candidate(event, candidate_clips=candidate_clips):
                                if event["kind"] == "synthesized":
                                    candidate_clips[event["id"]] = event

                            await self.phase(
                                record,
                                self.tts_command,
                                "tts",
                                {
                                    **config,
                                    "directory": str(candidate_directory),
                                    "phrases": [
                                        {
                                            **t,
                                            "text": candidate_text[t["id"]],
                                            "voice": record.voice_assignments[
                                                p["speaker_id"] or "unknown"
                                            ],
                                        }
                                        for p, t in group
                                    ],
                                },
                                receive_candidate,
                                stage_name="fit",
                            )
                            await self.phase(
                                record,
                                [sys.executable, "-m", "transcription.video_worker"],
                                "pauses",
                                {"clips": list(candidate_clips.values())},
                                receive_candidate,
                            )
                            if all(t["id"] in candidate_clips for _, t in group):
                                candidate_total = sum(
                                    candidate_clips[t["id"]]["duration"] for _, t in group
                                )
                                if candidate_total < total:
                                    clips.update(candidate_clips)
                                    rephrased = candidate_text
                                    rephrased_warnings = candidate_warnings
                                    total = candidate_total
                    except WorkerFailure:
                        break
                if total > available:
                    speed = min(1.15, total / available + 0.01)
                    await self.phase(
                        record,
                        [sys.executable, "-m", "transcription.video_worker"],
                        "fit",
                        {"speed": speed, "clips": [clips[t["id"]] for _, t in group]},
                        receive,
                    )
                    total = sum(clips[t["id"]]["duration"] for _, t in group)
                for _, translation in group:
                    clip = clips[translation["id"]]
                    if translation["id"] in rephrased:
                        translation["text"] = rephrased[translation["id"]]
                        translation["warnings"] = rephrased_warnings.get(translation["id"], [])
                        translation["status"] = (
                            "warning" if translation["warnings"] else "translated"
                        )
                    translation.update(
                        playback_start=start, playback_end=start + clip["duration"], status="ready"
                    )
                    placements.append({**clip, "start": start})
                    start += clip["duration"]
                lag = max(0.0, start - deadline)
                for _, translation in group:
                    translation["lag_seconds"] = lag
                if lag > self.settings.voiceover_max_lag + 0.02:
                    record.problems.append(
                        {
                            "start": anchor,
                            "end": end,
                            "reason": "timing_overflow",
                            "lag_seconds": lag,
                            "limit_seconds": self.settings.voiceover_max_lag,
                        }
                    )
                playback_cursor = start
            config["placements"] = placements
            config["source_duration"] = record.duration
            config["duration"] = max(record.duration or 0, playback_cursor)
            await self.phase(
                record,
                [sys.executable, "-m", "transcription.video_worker"],
                "render",
                config,
                lambda event: None,
            )
            record.duration = config["duration"]
            record.assets = {
                key: f"/trancription-api/voiceovers/{record.id}/media/{key}"
                for key in ("video", "audio")
            }
            for temporary in self.directory(record.id).iterdir():
                if temporary.name not in {
                    "source",
                    "video.mp4",
                    "translation.m4a",
                    "processing.jsonl",
                }:
                    if temporary.is_dir():
                        await asyncio.to_thread(shutil.rmtree, temporary)
                    else:
                        await asyncio.to_thread(temporary.unlink)
            self.stop_clock(record)
            record.status = "incomplete" if record.problems else "completed"
            record.storage_bytes = sum(
                p.stat().st_size
                for p in self.directory(record.id).iterdir()
                if p.name != "processing.jsonl"
            )
            record.revision += 1
            self.save(record)
            self.active = None
        except (WorkerFailure, OSError, ValueError, KeyError) as error:
            self.fail(
                record,
                str(error) if isinstance(error, WorkerFailure) else type(error).__name__,
                (error.message if isinstance(error, WorkerFailure) else None)
                or "Не удалось подготовить озвучку",
            )

    def media(self, record_id: str, kind: str) -> Path:
        record = self.get(record_id)
        if record.status not in {"completed", "incomplete"} or kind not in {"video", "audio"}:
            raise HTTPException(404, "Медиа недоступно")
        return self.directory(record_id) / ("video.mp4" if kind == "video" else "translation.m4a")

    def sample(self, voice: str) -> Path:
        directory = self.database.parent / "voice-samples" / self.sample_key
        if voice not in self.voices:
            raise HTTPException(404, "Голос не найден")
        path = directory / f"{voice}.wav"
        if not path.is_file():
            raise HTTPException(404, "Образец ещё не подготовлен")
        return path

    def assign(self, record_id: str, body: VoiceAssignment) -> VoiceoverSnapshot:
        record = self.get(record_id)
        if (
            record.status not in {"awaiting_voices", "completed", "incomplete"}
            or record.revision != body.expected_revision
        ):
            raise HTTPException(409, {"code": "revision_conflict", "snapshot": record.model_dump()})
        if set(body.voice_assignments) != set(record.voice_assignments) or not set(
            body.voice_assignments.values()
        ) <= set(record.available_voices or self.voices):
            raise HTTPException(422, "Назначьте известный голос каждому спикеру")
        record.voice_assignments = body.voice_assignments
        record.revision += 1
        self.save(record)
        return record

    def library(self, cursor: str | None, limit: int) -> dict:
        records = sorted(self.records.values(), key=lambda r: (r.created_at, r.id), reverse=True)
        if cursor:
            try:
                timestamp, record_id = json.loads(base64.urlsafe_b64decode(cursor))
                if not isinstance(timestamp, str) or not isinstance(record_id, str):
                    raise TypeError()
            except (ValueError, TypeError):
                raise HTTPException(422, "Некорректный cursor")
            records = [r for r in records if (r.created_at, r.id) < (timestamp, record_id)]
        page = records[:limit]
        next_cursor = None
        if len(records) > limit:
            last = page[-1]
            next_cursor = base64.urlsafe_b64encode(
                json.dumps([last.created_at, last.id]).encode()
            ).decode()
        return {
            "items": [
                {
                    "id": r.id,
                    "status": r.status,
                    "revision": r.revision,
                    "title": r.source.get("name") or r.source.get("url") or "Видео",
                    "source": r.source,
                    "stages": r.stages,
                    "created_at": r.created_at,
                    "storage_bytes": r.storage_bytes,
                    "duration": r.duration,
                }
                for r in page
            ],
            "next_cursor": next_cursor,
        }

    def reserve(self, body: VoiceoverRequest) -> VoiceoverSnapshot:
        devices = {key: getattr(body, key, None) for key in ("asr_gpu", "tts_gpu")}
        if any(devices.values()):
            available = {device["value"] for device in self.devices()}
            if any(value and value not in available for value in devices.values()):
                raise HTTPException(
                    422,
                    {
                        "code": "invalid_gpu",
                        "message": "Выбранная видеокарта недоступна. Обновите список устройств.",
                    },
                )
        selected = {key: value or getattr(self.settings, key) for key, value in devices.items()}
        selected["diarization_gpu"] = devices["asr_gpu"] or self.settings.diarization_gpu
        record = VoiceoverSnapshot(
            id=str(uuid4()),
            source={
                "kind": body.source_kind,
                **({"name": body.filename} if body.filename else {"url": body.url or ""}),
            },
            devices=selected,
            auto_synthesize=getattr(body, "auto_synthesize", False),
            created_at=datetime.now(UTC).isoformat(),
            status="preparing" if body.source_kind == "youtube" else "awaiting_upload",
        )
        self.save(record, body)
        self.records[record.id] = record
        self.requests[body.client_request_id] = (body.model_dump(), record.id)
        self.active = record.id
        if body.source_kind == "youtube":
            self.tasks[record.id] = asyncio.create_task(self.prepare(record))
        return record
