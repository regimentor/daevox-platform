"""Conservative pause compression; never remove an entire low-volume recording."""

import array
import math
import sys
import wave
from pathlib import Path


def compress_pauses(path: str) -> tuple[str, float]:
    with wave.open(path, "rb") as source:
        if source.getparams()[:3] != (1, 2, 24000):
            raise ValueError("Unexpected clip format")
        samples = array.array("h", source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    # 10 ms blocks; only the middle of long quiet runs is removed. Keep 120 ms
    # at each speech boundary. Relative gate protects consistently quiet voices.
    size = 240
    levels = [
        math.sqrt(sum(v * v for v in samples[i : i + size]) / len(samples[i : i + size]))
        for i in range(0, len(samples), size)
    ]
    if not levels:
        raise ValueError("Empty speech audio")
    threshold = min(32768 * 10 ** (-45 / 20), max(levels) * 0.02)
    cuts = []
    begin = None
    for index, level in enumerate([*levels, float("inf")]):
        if level <= threshold and begin is None:
            begin = index
        elif level > threshold and begin is not None:
            # Leave the edges and any entirely quiet audio alone.
            if begin > 0 and index < len(levels) and index - begin >= 40:
                cuts.append(((begin + 12) * size, (index - 12) * size))
            begin = None
    output = array.array("h")
    position = 0
    for start, end in cuts:
        output.extend(samples[position:start])
        position = end
    output.extend(samples[position:])
    destination = str(Path(path).with_suffix(".pauses.wav"))
    if sys.byteorder != "little":
        output.byteswap()
    with wave.open(destination, "wb") as target:
        target.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        target.writeframes(output.tobytes())
    return destination, len(output) / 24000
