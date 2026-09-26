"""Write the golden binary-frame fixtures shared by pytest and the SDK's vitest suite.

uv run python -m tools.make_frame_fixtures
"""

import json
from pathlib import Path

import numpy as np

from tidalviz.frame import SCALAR_NAMES, AudioFrame, new_frame
from tidalviz.transport.frame import encode

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def build(*, stereo: bool) -> AudioFrame:
    """A deterministic frame whose values are distinct per field and exact in float32."""
    f = new_frame(stereo=stereo)
    f.index = 4242
    f.sample_rate = 48000.0
    f.host_time = 98765.4321
    f.onset, f.silent = True, False
    f.scalars[:13] = [
        0.25,
        0.75,
        1.5,
        1.0,
        0.5,
        1.25,
        0.875,
        0.625,
        0.375,
        120.0,
        0.5,
        0.3125,
        0.125,
    ]
    f.scalars[13] = 0.0625  # onsetAge
    f.bands[:] = np.arange(64, dtype=np.float32) / 64
    f.spectrum[:] = (np.arange(1024, dtype=np.float32) % 32) / 32
    f.waveform[:] = (np.arange(2048, dtype=np.float32) - 1024) / 1024
    if f.left is not None and f.right is not None:
        f.left[:] = f.waveform * 0.5
        f.right[:] = -f.waveform
    return f


def describe(f: AudioFrame) -> dict[str, object]:
    def arr(a: np.ndarray | None) -> list[float] | None:
        return None if a is None else [float(x) for x in a]

    return {
        "frameIndex": f.index, "sampleRate": f.sample_rate, "hostTime": f.host_time,
        "onset": f.onset, "silent": f.silent, "stereo": f.stereo,
        "scalarNames": list(SCALAR_NAMES), "scalars": arr(f.scalars),
        "bands": arr(f.bands), "spectrum": arr(f.spectrum), "waveform": arr(f.waveform),
        "left": arr(f.left), "right": arr(f.right),
    }  # fmt: skip


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, stereo in (("mono", False), ("stereo", True)):
        frame = build(stereo=stereo)
        (FIXTURES / f"frame_v1_{name}.bin").write_bytes(encode(frame))
        (FIXTURES / f"frame_v1_{name}.json").write_text(json.dumps(describe(frame)) + "\n")
        print(f"wrote frame_v1_{name}.bin/.json")


if __name__ == "__main__":
    main()
