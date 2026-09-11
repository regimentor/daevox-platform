"""Constraints shared by translation and measured speech selection."""

import re
from collections import Counter

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
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


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


def preserves_entities(source: str, candidate: str, terms: list[str]) -> bool:
    source = re.sub(r"\b([A-Z]{2,})s\b", r"\1", source)
    candidate = re.sub(r"\b([A-Z]{2,})s\b", r"\1", candidate)
    if Counter(NUMBER.findall(source)) != Counter(NUMBER.findall(candidate)):
        return False
    return all(re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", candidate) for term in terms)


def semantic_windows(phrases: list[dict]) -> list[dict]:
    """Repair conservative English ASR clause boundaries without rewriting source words."""
    windows: list[dict] = []
    for phrase in phrases:
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
                {**phrase, "words": list(phrase["words"]), "source_segment_ids": [phrase["id"]]}
            )
    return windows


def translation_warnings(source: str, candidate: str, terms: list[str]) -> list[dict]:
    """Advisory checks; never discard a usable translation."""

    def numbers(text):
        text = re.sub(r"(?<=\d)[ \u00a0\u202f](?=\d{3}(?:\D|$))", "", text)
        text = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", text)
        return Counter(value.replace(",", ".") for value in NUMBER.findall(text))

    warnings: list[dict] = []
    if numbers(source) != numbers(candidate):
        warnings.append(
            {
                "code": "numbers_changed",
                "message": "Числа в оригинале и переводе могут различаться. Проверьте значения.",
            }
        )
    missing = [
        term
        for term in terms
        if not re.search(r"(?<!\w)" + re.escape(term) + r"s?(?!\w)", candidate, re.IGNORECASE)
    ]
    if missing:
        warnings.append(
            {
                "code": "terms_changed",
                "message": "Проверьте передачу терминов: " + ", ".join(missing),
                "terms": missing,
            }
        )
    return warnings
