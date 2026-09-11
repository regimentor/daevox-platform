"""One model process per operation, with serialized requests and bounded lifetime."""

import asyncio
import json
import os
import signal
import time
from collections.abc import Callable
from uuid import uuid4

from .diagnostics import append_event
from .processes import WorkerFailure, worker_environment


class PersistentWorker:
    def __init__(self, command: list[str]):
        self.command = command
        self.process: asyncio.subprocess.Process | None = None
        self.stderr_task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.closed = False
        self.log = None
        self.context: dict = {}

    def journal(self, event, **payload):
        append_event(self.log, event, **self.context, **payload)

    async def run(self, role: str, config: dict, receive: Callable[[dict], None]):
        async with self.lock:
            if self.closed:
                raise WorkerFailure("worker_closed")
            self.log = config.get("diagnostic_path")
            self.context = {
                "run_id": uuid4().hex,
                "role": role,
                "operation_id": config.get("operation_id"),
            }
            started = time.monotonic()
            self.journal("worker.start", command=self.command, persistent=True)
            try:
                if self.process is None:
                    self.process = await asyncio.create_subprocess_exec(
                        *self.command,
                        "serve",
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        start_new_session=True,
                        env=worker_environment(),
                        limit=16 * 1024 * 1024,
                    )
                    self.stderr_task = asyncio.create_task(self.drain_stderr())
                    self.journal("worker.spawned", worker_pid=self.process.pid)
                process = self.process
                assert process.stdin and process.stdout
                process.stdin.write((json.dumps(config) + "\n").encode())
                await process.stdin.drain()
                while line := await process.stdout.readline():
                    event = json.loads(line)
                    self.journal("worker.event", payload=event)
                    if event["kind"] == "diagnostic":
                        continue
                    if event["kind"] == "error":
                        raise WorkerFailure(event.get("code", "worker_error"), event.get("message"))
                    receive(event)
                    if event["kind"] == "done":
                        return
                raise WorkerFailure("worker_unexpected_eof")
            except BaseException:
                await self.close()
                raise
            finally:
                self.journal(
                    "worker.exit", elapsed_seconds=time.monotonic() - started, persistent=True
                )

    async def drain_stderr(self):
        assert self.process and self.process.stderr
        while chunk := await self.process.stderr.read(65536):
            self.journal("worker.stderr", text=chunk.decode("utf-8", errors="replace"))

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process is not None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                pass
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await self.process.wait()
        if self.stderr_task is not None:
            await self.stderr_task
