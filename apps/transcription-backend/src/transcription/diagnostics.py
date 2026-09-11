"""Append-only per-video JSON Lines journal, shared safely by concurrent stages."""

import fcntl
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SECRET = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|(?:^|[_-])token$)",
    re.IGNORECASE,
)


def redact(value):
    if isinstance(value, dict):
        return {
            key: "<REDACTED>" if SECRET.search(str(key)) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        if value.lstrip().startswith(("{", "[")):
            try:
                return json.dumps(redact(json.loads(value)), ensure_ascii=False)
            except ValueError:
                pass
        value = re.sub(r"(?i)(Bearer\s+)[^\s\"']+", r"\1<REDACTED>", value)
        value = re.sub(
            r"(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+",
            r"\1<REDACTED>",
            value,
        )
        if value.startswith(("http://", "https://")):
            try:
                url = urlsplit(value)
                host = url.netloc.rsplit("@", 1)[-1]
                value = urlunsplit(
                    (
                        url.scheme,
                        host,
                        url.path,
                        urlencode(
                            [
                                (
                                    key,
                                    "<REDACTED>"
                                    if SECRET.search(key) or key.lower() == "token"
                                    else item,
                                )
                                for key, item in parse_qsl(url.query, keep_blank_values=True)
                            ]
                        ),
                        url.fragment,
                    )
                )
            except ValueError:
                pass
        return value
    return value


def append_event(path: str | Path | None, event: str, **payload):
    if path is None:
        return
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "schema_version": 1,
        "timestamp": datetime.now(UTC).isoformat(),
        "pid": os.getpid(),
        "event": event,
        **redact(payload),
    }
    line = json.dumps(data, ensure_ascii=False, default=str) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(line)
        stream.flush()
        fcntl.flock(stream, fcntl.LOCK_UN)
