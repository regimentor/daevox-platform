import asyncio
import json
import os
import signal
import sysconfig
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from .diagnostics import append_event


class WorkerFailure(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(code)
        self.message = message


def worker_environment():
    environment = os.environ.copy()
    libraries = sorted((Path(sysconfig.get_paths()["purelib"]) / "nvidia").glob("*/lib"))
    environment["LD_LIBRARY_PATH"] = ":".join(
        [*(str(path) for path in libraries), environment.get("LD_LIBRARY_PATH", "")]
    )
    return environment


async def run_worker(command: list[str], role: str, config: dict, receive: Callable[[dict], None]):
    log = config.get("diagnostic_path")
    run_id = uuid4().hex
    started = time.monotonic()

    def journal(event, **payload):
        append_event(
            log, event, run_id=run_id, role=role, operation_id=config.get("operation_id"), **payload
        )

    journal("worker.start", command=command, config=config)
    environment = worker_environment()
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            role,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE if log else asyncio.subprocess.DEVNULL,
            start_new_session=True,
            env=environment,
            limit=16 * 1024 * 1024,
        )
    except OSError as error:
        journal(
            "worker.failure",
            error_type=type(error).__name__,
            message=str(error),
            traceback=traceback.format_exc(),
        )
        raise

    async def drain_stderr():
        assert process.stderr
        while chunk := await process.stderr.read(65536):
            journal("worker.stderr", text=chunk.decode("utf-8", errors="replace"))

    stderr_task = asyncio.create_task(drain_stderr()) if log else None
    journal("worker.spawned", worker_pid=process.pid)
    try:
        assert process.stdin and process.stdout
        process.stdin.write((json.dumps(config) + "\n").encode())
        await process.stdin.drain()
        process.stdin.close()
        done = False
        buffer = b""
        while chunk := await process.stdout.read(65536):
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                try:
                    event = json.loads(line)
                except ValueError:
                    journal("worker.invalid_stdout", raw=line.decode("utf-8", errors="replace"))
                    raise
                journal("worker.event", payload=event)
                if event["kind"] == "diagnostic":
                    continue
                if event["kind"] == "error":
                    raise WorkerFailure(event.get("code", "worker_error"), event.get("message"))
                done |= event["kind"] == "done"
                receive(event)
        if buffer:
            raise WorkerFailure("truncated_worker_event")
        code = await process.wait()
        if code != 0 or not done:
            raise WorkerFailure(f"worker_exit_{code}")
    except BaseException as error:
        journal(
            "worker.failure",
            error_type=type(error).__name__,
            message=str(error),
            traceback=traceback.format_exc(),
        )
        raise
    finally:
        # The group includes ffmpeg/JS-runtime children; do not leave them alive on cancellation.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 3)
        except TimeoutError:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()
        if stderr_task:
            await stderr_task
        journal(
            "worker.exit", returncode=process.returncode, elapsed_seconds=time.monotonic() - started
        )
