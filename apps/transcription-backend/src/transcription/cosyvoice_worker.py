"""Standalone adapter executed in CosyVoice's isolated, pinned Python environment."""

import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path


def synthesize(config, events, models):

    def emit(**event):
        print(json.dumps(event), file=events, flush=True)

    try:
        signature = tuple(
            config[key] for key in ("tts_gpu", "cosyvoice_source_path", "cosyvoice_model_path")
        )
        if models and models[0] != signature:
            raise ValueError("A model session cannot change GPU or model")
        if not models:
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
            import torch

            source = Path(config["cosyvoice_source_path"])
            sys.path[:0] = [str(source), str(source / "third_party" / "Matcha-TTS")]
            from cosyvoice.cli.cosyvoice import CosyVoice3

            model = CosyVoice3(config["cosyvoice_model_path"], fp16=True)
            models.extend([signature, model])
        import soundfile as sf
        import torch

        model = models[1]
        source = Path(config["cosyvoice_source_path"])
        voices = config.get("cosyvoice_voices") or {
            "demo": str(source / "asset" / "cross_lingual_prompt.wav")
        }
        for phrase in config["phrases"]:
            reference = phrase.get("reference_path") or voices.get(phrase["voice"])
            if reference is None:
                raise ValueError("Unknown CosyVoice voice")
            with torch.inference_mode():
                chunks = [
                    output["tts_speech"].detach().cpu()
                    for output in model.inference_cross_lingual(
                        "You are a helpful assistant.<|endofprompt|>" + phrase["text"],
                        reference,
                        stream=False,
                        text_frontend=False,
                    )
                ]
            if not chunks:
                raise ValueError("Empty CosyVoice audio")
            samples = torch.cat(chunks, dim=-1).numpy().reshape(-1)
            if model.sample_rate != 24000 or len(samples) == 0:
                raise ValueError("Unexpected CosyVoice audio")
            destination = Path(config["directory"]) / (phrase["id"] + ".wav")
            sf.write(destination, samples, model.sample_rate, subtype="PCM_16")
            emit(
                kind="synthesized",
                id=phrase["id"],
                path=str(destination),
                duration=len(samples) / model.sample_rate,
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
            message=f"В окружении озвучки отсутствует Python-модуль «{module}». Проверьте путь CosyVoice Python и зависимости его виртуального окружения.",
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


def main():
    events = sys.stdout
    sys.stdout = sys.stderr
    models: list = []
    for line in sys.stdin:
        synthesize(json.loads(line), events, models)
        if "serve" not in sys.argv[1:]:
            break


if __name__ == "__main__":
    main()
