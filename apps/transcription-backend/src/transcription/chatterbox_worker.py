"""Standalone adapter executed in Chatterbox's isolated, pinned Python environment."""

import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path


def main():
    config = json.loads(sys.stdin.readline())
    events = sys.stdout
    sys.stdout = sys.stderr

    def emit(**event):
        print(json.dumps(event), file=events, flush=True)

    try:
        devices = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=uuid,name", "--format=csv,noheader"], text=True
        )
        matches = [
            line.split(",", 1)[0].strip()
            for line in devices.splitlines()
            if config["tts_gpu"] in [part.strip() for part in line.split(",", 1)]
        ]
        if len(matches) != 1:
            raise ValueError("GPU selection must identify one device")
        os.environ["CUDA_VISIBLE_DEVICES"] = matches[0]
        import soundfile as sf
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        model = ChatterboxMultilingualTTS.from_local(
            config["chatterbox_model_path"], device="cuda", t3_model="v3"
        )
        voices = config.get("chatterbox_voices", {})
        for phrase in config["phrases"]:
            reference = phrase.get("reference_path") or voices.get(phrase["voice"])
            if reference is None and (voices or phrase["voice"] != "default"):
                raise ValueError("Unknown Chatterbox voice")
            with torch.inference_mode():
                audio = model.generate(
                    text=phrase["text"],
                    language_id="ru",
                    audio_prompt_path=reference,
                    exaggeration=config.get("chatterbox_exaggeration", 0.5),
                    cfg_weight=config.get("chatterbox_cfg_weight", 0.5),
                )
            samples = audio.detach().cpu().numpy().reshape(-1)
            if model.sr != 24000 or len(samples) == 0:
                raise ValueError("Unexpected Chatterbox audio")
            destination = Path(config["directory"]) / (phrase["id"] + ".wav")
            sf.write(destination, samples, model.sr, subtype="PCM_16")
            emit(
                kind="synthesized",
                id=phrase["id"],
                path=str(destination),
                duration=len(samples) / model.sr,
                text=phrase["text"],
            )
        emit(kind="done")
    except ModuleNotFoundError as error:
        if config.get("diagnostic_path"):
            emit(
                kind="diagnostic",
                event="worker.exception",
                error_type=type(error).__name__,
                message=str(error),
                traceback=traceback.format_exc(),
                stderr=str(getattr(error, "stderr", "") or ""),
                stdout=str(getattr(error, "stdout", "") or ""),
            )
        module = (
            error.name
            if error.name and re.fullmatch(r"[a-zA-Z0-9_.]+", error.name)
            else "неизвестный"
        )
        emit(
            kind="error",
            code="missing_dependency",
            message=f"В окружении озвучки отсутствует Python-модуль «{module}». Проверьте путь Chatterbox Python и зависимости его виртуального окружения.",
        )
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 -- external runtime boundary
        if config.get("diagnostic_path"):
            emit(
                kind="diagnostic",
                event="worker.exception",
                error_type=type(error).__name__,
                message=str(error),
                traceback=traceback.format_exc(),
                stderr=str(getattr(error, "stderr", "") or ""),
                stdout=str(getattr(error, "stdout", "") or ""),
            )
        emit(kind="error", code=type(error).__name__)
        sys.exit(1)


if __name__ == "__main__":
    main()
