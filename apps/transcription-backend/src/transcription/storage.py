import json
import os
import re
from pathlib import Path

from .models import Snapshot


def timestamp(seconds: float) -> str:
    value = max(0, int(seconds))
    return f"{value // 3600:02}:{value // 60 % 60:02}:{value % 60:02}"


def save_result(snapshot: Snapshot, data_dir: Path, models: dict) -> dict[str, str]:
    name = snapshot.source.get("name", "youtube")
    safe = re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._")
    safe = safe.encode("utf-8")[:120].decode("utf-8", errors="ignore") or "source"
    directory = data_dir.resolve() / "results" / f"{safe}-{snapshot.operation_id}"
    directory.mkdir(parents=True, exist_ok=True)
    labels = {speaker.id: speaker.label for speaker in snapshot.speakers}
    lines = [name if snapshot.source["kind"] == "file" else snapshot.source["url"]]
    if snapshot.status != "completed":
        lines.append("Неполный результат")
    for segment in snapshot.segments:
        speaker = labels.get(
            segment.speaker_id or "",
            "Спикер определяется" if segment.speaker_status == "pending" else "Неизвестный спикер",
        )
        overlap = " [Одновременная речь]" if segment.overlap else ""
        lines.append(f"[{timestamp(segment.start)}] {speaker}{overlap}: {segment.text.strip()}")
    document = {
        "schema_version": 1,
        "operation_id": snapshot.operation_id,
        "source": snapshot.source,
        "language": {
            "requested": snapshot.language_requested,
            "detected": snapshot.language_detected,
        },
        "models": models,
        "status": snapshot.status,
        "completeness": snapshot.completeness.model_dump(),
        "speakers": [speaker.model_dump() for speaker in snapshot.speakers],
        "segments": [segment.model_dump() for segment in snapshot.segments],
        "speaker_turns": [turn.model_dump() for turn in snapshot.speaker_turns],
        "error": snapshot.error.model_dump() if snapshot.error else None,
    }
    for extension, content in (
        ("txt", "\n".join(lines) + "\n"),
        ("json", json.dumps(document, ensure_ascii=False, indent=2)),
    ):
        target = directory / f"transcript.{extension}"
        temporary = target.with_suffix(f".{extension}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(target)
            snapshot.output_paths[extension] = str(target)
        finally:
            temporary.unlink(missing_ok=True)
    return snapshot.output_paths
