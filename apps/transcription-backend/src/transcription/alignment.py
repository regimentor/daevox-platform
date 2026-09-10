from typing import Literal

from .models import Segment, Speaker, Turn


def normalize_turns(turns: list[Turn]) -> tuple[list[Turn], list[Speaker]]:
    mapping: dict[str, str] = {}
    ordered = sorted(turns, key=lambda turn: (turn.start, turn.end, turn.speaker_id))
    for turn in ordered:
        mapping.setdefault(turn.speaker_id, f"speaker_{len(mapping) + 1}")
    return (
        [turn.model_copy(update={"speaker_id": mapping[turn.speaker_id]}) for turn in ordered],
        [
            Speaker(id=value, label=f"Спикер {index + 1}")
            for index, value in enumerate(mapping.values())
        ],
    )


def align(words: list[dict], turns: list[Turn], ready: bool, prefix: str) -> list[Segment]:
    segments: list[Segment] = []
    for index, word in enumerate(words):
        start, end = word["start"], word["end"]
        scores: dict[str, float] = {}
        active = []
        for turn in turns:
            intersection = min(end, turn.end) - max(start, turn.start)
            if intersection > 0:
                scores[turn.speaker_id] = scores.get(turn.speaker_id, 0) + intersection
                active.append(turn)
        speaker = max(scores, key=lambda key: scores[key]) if scores else None
        overlap = any(
            a.speaker_id != b.speaker_id and min(end, a.end, b.end) > max(start, a.start, b.start)
            for i, a in enumerate(active)
            for b in active[i + 1 :]
        )
        status: Literal["assigned", "unknown", "pending"] = (
            "assigned" if speaker else "unknown" if ready else "pending"
        )
        if segments and (
            segments[-1].speaker_id,
            segments[-1].speaker_status,
        ) == (speaker, status):
            segments[-1].text += word["text"]
            segments[-1].end = end
            segments[-1].overlap |= overlap
        else:
            segments.append(
                Segment(
                    id=f"{prefix}-{index}",
                    start=start,
                    end=end,
                    text=word["text"],
                    speaker_id=speaker,
                    speaker_status=status,
                    overlap=overlap,
                )
            )
    return segments


def merge_speaker_blocks(segments: list[Segment]) -> list[Segment]:
    """Keep ASR batch boundaries out of assigned speaker utterances."""
    blocks: list[Segment] = []
    for segment in segments:
        if (
            blocks
            and segment.speaker_id is not None
            and segment.speaker_status == blocks[-1].speaker_status == "assigned"
            and segment.speaker_id == blocks[-1].speaker_id
        ):
            blocks[-1].text += segment.text
            blocks[-1].end = max(blocks[-1].end, segment.end)
            blocks[-1].overlap |= segment.overlap
        else:
            blocks.append(segment.model_copy())
    return blocks
