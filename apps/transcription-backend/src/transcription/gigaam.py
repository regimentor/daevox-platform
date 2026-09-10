"""Pinned GigaAM weights with the official decoder's word emission timestamps."""

import json
from pathlib import Path

MODEL_ID = "ai-sage/GigaAM-v3"


def recognize_russian(config, emit, stage):
    import soundfile as sf
    import torch
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    from gigaam.model import GigaAMASR
    from huggingface_hub import snapshot_download
    from omegaconf import OmegaConf

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    stage("asr_model", detail="GigaAM-v3: скачивание весов или чтение кэша, загрузка на GPU")
    path = Path(
        snapshot_download(
            MODEL_ID,
            revision=config["gigaam_revision"],
            allow_patterns=["config.json", "pytorch_model.bin", "tokenizer.model"],
        )
    )
    cfg = json.loads((path / "config.json").read_text())["cfg"]["model"]["cfg"]
    # HF and the native library expose the same model under different module paths.
    # Use the pinned native implementation to retain word timestamps, absent in the HF wrapper.
    targets = {
        "preprocessor": "gigaam.preprocess.FeatureExtractor",
        "encoder": "gigaam.encoder.ConformerEncoder",
        "head": "gigaam.decoder.RNNTHead",
        "decoding": "gigaam.decoding.RNNTGreedyDecoding",
    }
    for component, target in targets.items():
        cfg[component]["_target_"] = target
    cfg["decoding"]["model_path"] = str(path / "tokenizer.model")
    model = GigaAMASR(OmegaConf.create(cfg))
    weights = torch.load(path / "pytorch_model.bin", map_location="cpu", weights_only=True)
    model.load_state_dict({key.removeprefix("model."): value for key, value in weights.items()})
    del weights
    model.encoder.half()
    model.eval().to("cuda:0")
    emit(
        kind="model",
        model={
            "id": MODEL_ID,
            "revision": path.name,
            "variant": "e2e_rnnt",
            "device": config["asr_gpu"],
            "compute_type": "float16_encoder",
            "engine": "gigaam@7447938d791c4f3e643386ee22c33777004293a5",
            "timestamps": "rnnt_token_emissions",
            "vad": "silero/faster-whisper-1.2.1",
        },
    )
    stage("asr_model", "completed")
    stage("asr", total_units=config["duration"], unit="seconds", detail="Поиск участков речи")
    audio, sample_rate = sf.read(config["audio_path"], dtype="float32")
    if sample_rate != 16000 or audio.ndim != 1:
        raise ValueError("Expected prepared 16 kHz mono audio")
    chunks = get_speech_timestamps(audio, VadOptions(max_speech_duration_s=20))
    chunk_path = Path(config["directory"]) / "gigaam-chunk.wav"
    have_text = False
    try:
        for chunk in chunks:
            start, end = chunk["start"], chunk["end"]
            sf.write(chunk_path, audio[start:end], sample_rate, subtype="PCM_16")
            result = model.transcribe(str(chunk_path), word_timestamps=True)
            words = []
            cursor = 0
            for word in result.words or []:
                position = result.text.find(word.text, cursor)
                if position < 0:
                    raise ValueError("GigaAM word timestamps do not match decoded text")
                stop = position + len(word.text)
                words.append(
                    {
                        "start": start / sample_rate + word.start,
                        "end": min(end / sample_rate, start / sample_rate + word.end),
                        "text": result.text[cursor:stop],
                    }
                )
                cursor = stop
            if result.text and not words:
                raise ValueError("GigaAM returned text without word timestamps")
            if words:
                words[-1]["text"] += result.text[cursor:]
                if have_text:
                    words[0]["text"] = " " + words[0]["text"]
                have_text = True
            emit(kind="words", language="ru", words=words)
            stage(
                "asr",
                completed_units=end / sample_rate,
                total_units=config["duration"],
                unit="seconds",
            )
    finally:
        chunk_path.unlink(missing_ok=True)
    # Silence still has a known language when Russian was explicitly selected.
    if not have_text:
        emit(kind="words", language="ru", words=[])
    stage(
        "asr",
        "completed",
        completed_units=config["duration"],
        total_units=config["duration"],
        unit="seconds",
    )
