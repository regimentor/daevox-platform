"""Constraints shared by translation and measured speech selection."""

import re

MAX_SPEECH_SPEED = 1.5


def phrase_deadlines(phrases: list[dict], duration: float) -> list[float]:
    """Share overlapping speech's window in source-duration order; never mix voices."""
    groups: list[list[dict]] = []
    end = -1.0
    for phrase in phrases:
        if not groups or phrase["start"] >= end:
            groups.append([])
        groups[-1].append(phrase)
        end = max(end, phrase["end"])
    deadlines = []
    for index, group in enumerate(groups):
        anchor = group[0]["start"]
        deadline = min(
            duration, groups[index + 1][0]["start"] if index + 1 < len(groups) else duration
        )
        weights = [max(0.001, p["end"] - p["start"]) for p in group]
        elapsed = 0.0
        for weight in weights:
            elapsed += weight
            deadlines.append(anchor + max(0, deadline - anchor) * elapsed / sum(weights))
    return deadlines


# Keep compound names intact. Projects can extend this list in Settings.
DEFAULT_TERMS = (
    "Rust",
    "QTile",
    "CUDA",
    "GPU",
    "AMD",
    "NVIDIA",
    "C++",
    "C#",
    "Python",
    "Vulkan",
    "OpenCL",
)


def protected_terms(source: str, glossary: list[str]) -> list[str]:
    source = re.sub(r"\b([A-Z]{2,})s\b", r"\1", source)
    identifiers = re.findall(r"\b(?:[A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z]*)\b", source)
    return sorted(
        {
            term
            for term in [*glossary, *identifiers]
            if re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", source)
        },
        key=lambda term: (-len(term), term),
    )


def semantic_windows(phrases: list[dict]) -> list[dict]:
    """Repair conservative English ASR clause boundaries without rewriting source words."""
    bounded: list[dict] = []
    for phrase in phrases:
        words = phrase.get("words", [])
        if phrase["end"] - phrase["start"] <= 18 or len(words) < 2:
            bounded.append(phrase)
            continue
        chunks: list[list[dict]] = []
        chunk: list[dict] = []
        for word in words:
            if chunk and word["end"] - chunk[0]["start"] > 18:
                chunks.append(chunk)
                chunk = []
            chunk.append(word)
        if chunk:
            chunks.append(chunk)
        if len(chunks) == 1:
            bounded.append(phrase)
            continue
        for index, words_chunk in enumerate(chunks):
            bounded.append(
                {
                    **phrase,
                    "id": f"{phrase['id']}:{index}",
                    "start": words_chunk[0]["start"],
                    "end": words_chunk[-1]["end"],
                    "text": "".join(word["text"] for word in words_chunk),
                    "words": words_chunk,
                    "source_segment_ids": [phrase["id"]],
                }
            )
    windows: list[dict] = []
    for phrase in bounded:
        continuation = re.match(
            r"(?:which\b|including\b|with libraries\b|for low-level\b|is the same reason\b|whether\b)",
            phrase["text"].strip(),
            re.IGNORECASE,
        )
        if (
            windows
            and continuation
            and windows[-1]["speaker_id"] is not None
            and windows[-1]["speaker_id"] == phrase["speaker_id"]
            and not windows[-1]["overlap"]
            and not phrase["overlap"]
            and 0 <= phrase["start"] - windows[-1]["end"] <= 0.6
            and phrase["end"] - windows[-1]["start"] <= 18
        ):
            windows[-1]["text"] += phrase["text"]
            windows[-1]["end"] = max(windows[-1]["end"], phrase["end"])
            windows[-1]["words"].extend(phrase["words"])
            windows[-1]["source_segment_ids"].append(phrase["id"])
        else:
            windows.append(
                {
                    **phrase,
                    "words": list(phrase["words"]),
                    "source_segment_ids": phrase.get("source_segment_ids", [phrase["id"]]),
                }
            )
    return windows
