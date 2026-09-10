"""Standalone adapter executed in Qwen's isolated, pinned Python environment."""

import json
import os
import subprocess
import sys
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
        from qwen_tts import Qwen3TTSModel

        model = Qwen3TTSModel.from_pretrained(
            config["qwen_model_path"],
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            local_files_only=True,
        )
        for start in range(0, len(config["phrases"]), 3):
            batch = config["phrases"][start : start + 3]
            waves, rate = model.generate_custom_voice(
                text=[p["text"] for p in batch],
                language=["Auto"] * len(batch),
                speaker=[p["voice"] for p in batch],
                instruct=[p.get("instruction", config["qwen_instruction"]) for p in batch],
                non_streaming_mode=True,
                max_new_tokens=2048,
            )
            if rate != 24000 or len(waves) != len(batch):
                raise ValueError("Unexpected Qwen audio")
            for phrase, audio in zip(batch, waves):
                if len(audio) == 0:
                    raise ValueError("Empty Qwen audio")
                destination = Path(config["directory"]) / (phrase["id"] + ".wav")
                sf.write(destination, audio, rate, subtype="PCM_16")
                emit(
                    kind="synthesized",
                    id=phrase["id"],
                    path=str(destination),
                    duration=len(audio) / rate,
                    text=phrase["text"],
                )
        emit(kind="done")
    except Exception as error:  # noqa: BLE001 -- external runtime boundary
        emit(kind="error", code=type(error).__name__)
        sys.exit(1)


if __name__ == "__main__":
    main()
