import asyncio
import json
import logging
import shutil
import sys
from collections import deque
from functools import partial
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException, Request
from starlette.requests import ClientDisconnect

from .alignment import align, merge_speaker_blocks, normalize_turns
from .config import Settings
from .models import TERMINAL, OperationError, Snapshot, Stage, StartRequest, Turn
from .processes import WorkerFailure, run_worker
from .storage import save_result

logger = logging.getLogger(__name__)


class Service:
    def __init__(self, settings: Settings, worker_command: list[str] | None = None):
        self.settings = settings
        self.command = worker_command or [sys.executable, "-m", "transcription.worker"]
        self.current: Snapshot | None = None
        self.request_id: str | None = None
        self.task: asyncio.Task | None = None
        self.timeout_task: asyncio.Task | None = None
        self.upload_done = asyncio.Event()
        self.upload_done.set()
        self.uploading = False
        self.words: list[list[dict]] = []
        self.models: dict = {}
        self.cleanup_failed = False
        self.history: deque[tuple[int, str]] = deque()
        self.history_bytes = 0
        self.changed = asyncio.Event()
        self.turns_ready = False

    def get(self, operation_id: str) -> Snapshot:
        if not self.current or self.current.operation_id != operation_id:
            raise HTTPException(404, "Operation not found")
        return self.current

    def publish(self, kind: str = "stage", **payload):
        assert self.current
        snapshot = self.current
        snapshot.revision += 1
        if kind == "terminal":
            data = snapshot.model_dump()
        elif kind == "transcript":
            data = {
                "revision": snapshot.revision,
                "transcript_revision": snapshot.transcript_revision,
                "speakers": [s.model_dump() for s in snapshot.speakers],
                "speaker_turns": [t.model_dump() for t in snapshot.speaker_turns],
                **payload,
            }
        else:
            data = {
                "revision": snapshot.revision,
                "changes": snapshot.model_dump(exclude={"segments", "speaker_turns", "speakers"}),
            }
        wire = self.wire(kind, data)
        self.history.append((snapshot.revision, wire))
        self.history_bytes += len(wire.encode())
        while (
            len(self.history) > self.settings.event_history or self.history_bytes > 4 * 1024 * 1024
        ):
            self.history_bytes -= len(self.history.popleft()[1].encode())
        self.changed.set()
        self.changed = asyncio.Event()

    @staticmethod
    def wire(kind: str, data: dict) -> str:
        return f"id: {data['revision']}\nevent: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def events(self, snapshot: Snapshot, cursor: int | None):
        while self.current is snapshot:
            changed = self.changed
            if (
                cursor is None
                or cursor > snapshot.revision
                or (
                    cursor < snapshot.revision
                    and (not self.history or cursor < self.history[0][0] - 1)
                )
            ):
                cursor = snapshot.revision
                yield self.wire("snapshot", snapshot.model_dump())
            else:
                # Copy before yielding: no subscriber holds back producers or mutable history.
                for revision, wire in list(self.history):
                    if revision > cursor:
                        cursor = revision
                        yield wire
            if snapshot.status in TERMINAL:
                return
            try:
                await asyncio.wait_for(changed.wait(), 15)
            except TimeoutError:
                yield ": keepalive\n\n"

    def reserve(self, body: StartRequest) -> Snapshot:
        if self.current and self.request_id == body.client_request_id:
            return self.current
        if self.current and (
            self.cleanup_failed
            or self.current.status not in TERMINAL
            or (self.task and not self.task.done())
        ):
            raise HTTPException(409, "An operation is already running")
        self.current = Snapshot(
            operation_id=str(uuid4()),
            source={
                "kind": body.source_kind,
                **({"name": body.filename} if body.filename else {"url": body.url or ""}),
            },
            language_requested=body.language,
        )
        self.request_id = body.client_request_id
        self.history.clear()
        self.history_bytes = 0
        self.turns_ready = False
        self.words = []
        self.models = {}
        self.uploading = False
        self.task = None
        if body.source_kind == "file":
            self.timeout_task = asyncio.create_task(self.expire(self.current))
        else:
            self.current.status = "running"
            self.task = asyncio.create_task(self.run(self.current))
        return self.current

    def temporary(self, snapshot: Snapshot) -> Path:
        return self.settings.data_dir.resolve() / "tmp" / snapshot.operation_id

    async def expire(self, snapshot: Snapshot):
        await asyncio.sleep(self.settings.upload_timeout)
        if snapshot.status == "awaiting_upload" and not self.uploading:
            snapshot.status = "running"
            snapshot.error = OperationError(
                code="upload_timeout", message="Передача файла не началась", stage="acquisition"
            )
            self.task = asyncio.create_task(self.finish(snapshot, "failed"))

    async def upload(self, operation_id: str, request: Request) -> Snapshot:
        snapshot = self.get(operation_id)
        if (
            snapshot.source["kind"] != "file"
            or snapshot.status != "awaiting_upload"
            or self.uploading
        ):
            raise HTTPException(409, "Source already accepted or operation is not awaiting upload")
        self.uploading = True
        self.upload_done.clear()
        if self.timeout_task:
            self.timeout_task.cancel()
        stage = snapshot.stages["acquisition"]
        stage.state, stage.unit = "running", "bytes"
        size = request.headers.get("content-length")
        stage.total_units = float(size) if size and size.isdigit() else None
        try:
            directory = self.temporary(snapshot)
            await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
            output = await asyncio.to_thread((directory / "source").open, "wb")
            try:
                iterator = request.stream().__aiter__()
                while snapshot.status != "cancelling":
                    # Wait for either a body chunk or cancellation, even if the sender stalls.
                    chunk_task = asyncio.create_task(anext(iterator, None))
                    try:
                        while not chunk_task.done() and snapshot.status != "cancelling":
                            await asyncio.wait({chunk_task}, timeout=0.1)
                        if snapshot.status == "cancelling":
                            break
                        chunk = chunk_task.result()
                        if chunk is None:
                            break
                        await asyncio.to_thread(output.write, chunk)
                        stage.completed_units += len(chunk)
                        self.publish()
                    finally:
                        if not chunk_task.done():
                            chunk_task.cancel()
                        await asyncio.gather(chunk_task, return_exceptions=True)
            finally:
                await asyncio.to_thread(output.close)
            if snapshot.status != "cancelling":
                stage.state = "completed"
                snapshot.status = "running"
                self.task = asyncio.create_task(self.run(snapshot))
        except (ClientDisconnect, OSError):
            if snapshot.status != "cancelling":
                stage.state = "failed"
                snapshot.error = OperationError(
                    code="upload_error",
                    message="Передача файла прервана или файл не удалось записать",
                    stage="acquisition",
                )
                snapshot.status = "running"
                self.task = asyncio.create_task(self.finish(snapshot, "failed"))
        finally:
            self.uploading = False
            self.upload_done.set()
        return snapshot

    def cancel(self, operation_id: str) -> Snapshot:
        snapshot = self.get(operation_id)
        if snapshot.status not in TERMINAL and snapshot.status != "cancelling":
            snapshot.status = "cancelling"
            self.publish()
            if self.timeout_task:
                self.timeout_task.cancel()
            previous = self.task
            self.task = asyncio.create_task(self.cancel_and_finish(snapshot, previous))
        return snapshot

    async def cancel_and_finish(self, snapshot, previous):
        if previous:
            previous.cancel()
            await asyncio.gather(previous, return_exceptions=True)
        await self.upload_done.wait()
        await self.finish(snapshot, "cancelled")

    async def run(self, snapshot: Snapshot):
        directory = self.temporary(snapshot)
        config = {
            "directory": str(directory),
            "source_path": str(directory / "source"),
            "source": snapshot.source,
            "language": snapshot.language_requested,
            "asr_revision": self.settings.asr_revision,
            "gigaam_revision": self.settings.gigaam_revision,
            "diarization_revision": self.settings.diarization_revision,
            "asr_gpu": self.settings.asr_gpu,
            "diarization_gpu": self.settings.diarization_gpu,
        }
        status = "completed"
        try:
            await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
            await run_worker(
                self.command,
                "preparation",
                config,
                lambda event: self.receive("preparation", event, config),
            )
            roles: tuple[Literal["asr", "diarization"], ...] = ("asr", "diarization")
            jobs = {
                role: asyncio.create_task(
                    run_worker(
                        self.command,
                        role,
                        config,
                        partial(self.receive_for, role, config),
                    )
                )
                for role in roles
            }
            try:
                pending = set(jobs.values())
                while pending:
                    done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                    for job in done:
                        role = next(role for role, task in jobs.items() if task is job)
                        try:
                            job.result()
                            setattr(snapshot.completeness, role, True)
                            snapshot.stages[role].state = "completed"
                            self.publish()
                        except (WorkerFailure, ValueError, OSError) as error:
                            status = "failed"
                            self.failure(role, error)
                            if role == "asr":
                                for task in pending:
                                    task.cancel()
                                await asyncio.gather(*pending, return_exceptions=True)
                                pending.clear()
            finally:
                for job in jobs.values():
                    if not job.done():
                        job.cancel()
                await asyncio.gather(*jobs.values(), return_exceptions=True)
        except (WorkerFailure, ValueError, OSError) as error:
            status = "failed"
            self.failure("preparation", error)
        await self.finish(snapshot, status)

    def failure(self, role, error):
        assert self.current
        model_stage = (
            self.current.stages["asr_model"]
            if role == "asr"
            else self.current.stages["diarization_model"]
            if role == "diarization"
            else None
        )
        if model_stage and model_stage.state == "running":
            model_stage.state = "failed"
        self.current.stages[role].state = "failed"
        code = str(error) if isinstance(error, WorkerFailure) else type(error).__name__
        self.current.error = OperationError(
            code=code,
            stage=role,
            message="Спикеры не определены; результат неполный. Проверьте доступ к Community-1 и CUDA."
            if role == "diarization"
            else "Обработка прервана. Проверьте источник, CUDA и доступ к весам.",
        )
        logger.warning(
            "worker_failed",
            extra={"operation_id": self.current.operation_id, "stage": role, "code": code},
        )
        self.publish()

    def receive_for(self, role: str, config: dict, event: dict):
        self.receive(role, event, config)

    def receive(self, role: str, event: dict, config: dict):
        assert self.current
        snapshot = self.current
        kind = event["kind"]
        if kind == "stage":
            snapshot.stages[event["name"]] = Stage.model_validate(
                {key: value for key, value in event.items() if key not in {"kind", "name"}}
            )
            self.publish()
        elif kind == "prepared":
            config.update(audio_path=event["path"], duration=event["duration"])
            snapshot.stages["preparation"].state = "completed"
            snapshot.stages["acquisition"].state = "completed"
            self.publish()
        elif kind == "model":
            self.models[role] = event["model"]
        elif kind == "words":
            self.words.append(event["words"])
            snapshot.language_detected = event["language"]
            previous = len(snapshot.segments)
            start = max(0, previous - 1)
            addition = align(
                event["words"], snapshot.speaker_turns, self.turns_ready, str(len(self.words))
            )
            addition = merge_speaker_blocks(snapshot.segments[start:] + addition)
            snapshot.segments[start:] = addition
            snapshot.transcript_revision += 1
            self.publish(
                "transcript",
                start_index=start,
                delete_count=previous - start,
                segments=[s.model_dump() for s in addition],
            )
        elif kind == "turns":
            self.turns_ready = True
            snapshot.speaker_turns, snapshot.speakers = normalize_turns(
                [Turn.model_validate(turn) for turn in event["turns"]]
            )
            previous = len(snapshot.segments)
            snapshot.segments = merge_speaker_blocks(
                [
                    segment
                    for index, words in enumerate(self.words, 1)
                    for segment in align(words, snapshot.speaker_turns, True, str(index))
                ]
            )
            snapshot.transcript_revision += 1
            self.publish(
                "transcript",
                start_index=0,
                delete_count=previous,
                segments=[s.model_dump() for s in snapshot.segments],
            )

    async def finish(self, snapshot: Snapshot, status):
        # Shield finalization: cancellation must not race a still-running filesystem thread.
        finalization = asyncio.create_task(self.finalize(snapshot, status))
        try:
            await asyncio.shield(finalization)
        except asyncio.CancelledError:
            await finalization
            raise

    async def finalize(self, snapshot: Snapshot, status):
        snapshot.stages["saving"].state = "running"
        for segment in snapshot.segments:
            if segment.speaker_status == "pending":
                segment.speaker_status = "unknown"
        self.publish()
        final = snapshot.model_copy(deep=True)
        final.status = status
        raw_text = "".join(word["text"] for batch in self.words for word in batch)
        if raw_text != "".join(segment.text for segment in final.segments):
            final.status = "failed"
            final.error = OperationError(
                code="transcript_integrity_error",
                message="Нарушена целостность текста при разметке спикеров",
                stage="saving",
            )
        for name, stage in final.stages.items():
            if name != "saving" and stage.state in {"running", "pending"}:
                stage.state = "cancelled"
        try:
            temporary = self.temporary(snapshot)
            if temporary.exists():
                await asyncio.to_thread(shutil.rmtree, temporary)
        except OSError:
            self.cleanup_failed = True
            final.status = "failed"
            final.error = OperationError(
                code="cleanup_error",
                message="Не удалось удалить временные файлы. Устраните ошибку доступа и перезапустите сервис.",
                stage="saving",
            )
        try:
            await asyncio.to_thread(save_result, final, self.settings.data_dir, self.models)
            final.stages["saving"].state = "completed"
        except OSError:
            final.status = "failed"
            final.stages["saving"].state = "failed"
            final.error = OperationError(
                code="storage_error", message="Не удалось сохранить результат", stage="saving"
            )
        snapshot.output_paths, snapshot.error = final.output_paths, final.error
        snapshot.stages = final.stages
        if snapshot.status == "cancelling" and status != "cancelled":
            # The cancellation owner will persist the partial result after this disk write
            # finishes. Publishing a terminal event here would close the browser's SSE early.
            self.publish()
            return
        snapshot.status = final.status
        self.publish("terminal")

    async def close(self):
        if self.current and self.current.status not in TERMINAL:
            self.cancel(self.current.operation_id)
        if self.timeout_task:
            self.timeout_task.cancel()
            await asyncio.gather(self.timeout_task, return_exceptions=True)
        if self.task:
            await self.task
