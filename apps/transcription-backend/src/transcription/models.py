import re
from typing import Literal
from urllib.parse import parse_qs, urlparse

from pydantic import BaseModel, Field, model_validator

Status = Literal["awaiting_upload", "running", "cancelling", "completed", "cancelled", "failed"]
StageName = Literal[
    "acquisition", "preparation", "asr_model", "diarization_model", "asr", "diarization", "saving"
]
STAGES: tuple[StageName, ...] = (
    "acquisition",
    "preparation",
    "asr_model",
    "diarization_model",
    "asr",
    "diarization",
    "saving",
)
TERMINAL = {"completed", "cancelled", "failed"}


class StartRequest(BaseModel):
    source_kind: Literal["file", "youtube"]
    filename: str | None = None
    url: str | None = None
    language: Literal["auto", "ru", "en"] = "auto"
    client_request_id: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_source(self):
        if self.source_kind == "file" and not self.filename:
            raise ValueError("filename is required")
        if self.source_kind == "youtube":
            url = urlparse(self.url or "")
            if (
                url.scheme != "https"
                or url.hostname
                not in {
                    "youtube.com",
                    "www.youtube.com",
                    "m.youtube.com",
                    "youtu.be",
                }
                or url.username
                or url.password
                or url.port not in (None, 443)
            ):
                raise ValueError("Expected an HTTPS YouTube video URL")
            parts = url.path.strip("/").split("/")
            video_id = (
                parts[0]
                if url.hostname == "youtu.be"
                else parse_qs(url.query).get("v", [""])[0]
                if url.path == "/watch"
                else parts[1]
                if len(parts) == 2 and parts[0] in {"shorts", "live", "embed"}
                else ""
            )
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                raise ValueError("Expected a single YouTube video, not a playlist or channel")
            self.filename = None
        return self


class Stage(BaseModel):
    state: Literal["pending", "running", "completed", "cancelled", "failed"] = "pending"
    completed_units: float = 0
    total_units: float | None = None
    unit: str = ""
    detail: str | None = None


class Segment(BaseModel):
    id: str
    start: float
    end: float
    text: str
    speaker_id: str | None = None
    speaker_status: Literal["pending", "assigned", "unknown"] = "pending"
    overlap: bool = False


class Turn(BaseModel):
    start: float
    end: float
    speaker_id: str


class Speaker(BaseModel):
    id: str
    label: str


class Completeness(BaseModel):
    asr: bool = False
    diarization: bool = False


class OperationError(BaseModel):
    code: str
    message: str
    stage: str | None = None


class Snapshot(BaseModel):
    operation_id: str
    revision: int = 1
    status: Status = "awaiting_upload"
    source: dict[str, str]
    language_requested: str
    language_detected: str | None = None
    stages: dict[StageName, Stage] = Field(default_factory=lambda: {s: Stage() for s in STAGES})
    transcript_revision: int = 0
    segments: list[Segment] = Field(default_factory=list)
    speaker_turns: list[Turn] = Field(default_factory=list)
    speakers: list[Speaker] = Field(default_factory=list)
    completeness: Completeness = Field(default_factory=Completeness)
    output_paths: dict[str, str] = Field(default_factory=dict)
    error: OperationError | None = None
