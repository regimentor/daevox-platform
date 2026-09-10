from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .dubbing import DEFAULT_TERMS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TRANSCRIPTION_")
    data_dir: Path = Path("data")
    host: str = "127.0.0.1"
    port: int = 3001
    upload_timeout: float = Field(default=60, gt=0)
    event_history: int = Field(default=128, gt=0)
    asr_gpu: str = "NVIDIA GeForce RTX 4070 Ti"
    diarization_gpu: str = "NVIDIA GeForce RTX 4070 Ti"
    llm_base_url: str = "http://127.0.0.1:8080/v1"
    llm_model: str = ""
    tts_gpu: str = "NVIDIA GeForce RTX 4070 Ti"
    voiceover_max_lag: float = Field(default=2.0, ge=0, le=10)
    tts_engine: Literal["silero", "qwen"] = "silero"
    qwen_python: str = "data/tts-options/qwen-env/bin/python"
    qwen_model_path: str = "data/tts-options/qwen-1.7b"
    qwen_instruction: str = "Read this technical narration in a neutral, matter-of-fact voice. Use even intonation, consistent volume, clear articulation and a steady pace with short natural pauses. No dramatic emphasis, excitement, sadness, laughter, sighs, or added interjections. Read only the supplied text."
    qwen_pace_instruction: str = "Read this technical narration in a neutral, matter-of-fact voice at a brisk, efficient speaking pace. Use short natural pauses, no dramatic emphasis, no emotions, no laughter or sighs. Articulate all words clearly. Read only the supplied text."
    tts_glossary: list[str] = Field(default_factory=lambda: list(DEFAULT_TERMS))
    silero_path: str = "data/models/v5_5_ru.pt"
    silero_sha256: str = "50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437"

    asr_revision: str = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
    gigaam_revision: str = "7655ad717f8122257385bb4b2f373db3697e8680"
    diarization_revision: str = "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
