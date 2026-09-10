import asyncio
import json
import os
import signal
import sysconfig
from collections.abc import Callable
from pathlib import Path


class WorkerFailure(Exception):
    pass


async def run_worker(command: list[str], role: str, config: dict, receive: Callable[[dict], None]):
    environment = os.environ.copy()
    libraries = sorted((Path(sysconfig.get_paths()["purelib"]) / "nvidia").glob("*/lib"))
    environment["LD_LIBRARY_PATH"] = ":".join(
        [*(str(path) for path in libraries), environment.get("LD_LIBRARY_PATH", "")]
    )
    process = await asyncio.create_subprocess_exec(
        *command,
        role,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
        env=environment,
        limit=16 * 1024 * 1024,
    )
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
                event = json.loads(line)
                if event["kind"] == "error":
                    raise WorkerFailure(event.get("code", "worker_error"))
                done |= event["kind"] == "done"
                receive(event)
        if buffer:
            raise WorkerFailure("truncated_worker_event")
        code = await process.wait()
        if code != 0 or not done:
            raise WorkerFailure(f"worker_exit_{code}")
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
