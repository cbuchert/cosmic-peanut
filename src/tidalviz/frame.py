"""The analysis frame shared by the analyzer, the encoder and tests (docs/protocols.md §1–2)."""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

F32 = NDArray[np.float32]

SCALAR_NAMES: tuple[str, ...] = (
    "rms", "peak", "bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt",
    "onsetStrength", "bpm", "beatPhase", "centroid", "flux",
    "onsetAge", "reserved14", "reserved15",
)  # fmt: skip
SCALAR_INDEX: dict[str, int] = {name: i for i, name in enumerate(SCALAR_NAMES)}

N_SCALARS = len(SCALAR_NAMES)
N_BANDS = 64
N_SPECTRUM = 1024
N_WAVEFORM = 512


@dataclass(slots=True)
class AudioFrame:
    index: int
    sample_rate: float
    host_time: float
    onset: bool
    silent: bool
    scalars: F32
    bands: F32
    spectrum: F32
    waveform: F32
    left: F32 | None
    right: F32 | None

    @property
    def stereo(self) -> bool:
        return self.left is not None


def new_frame(
    *,
    stereo: bool,
    bands: int = N_BANDS,
    spectrum: int = N_SPECTRUM,
    waveform: int = N_WAVEFORM,
) -> AudioFrame:
    """A zeroed frame with preallocated arrays, meant to be reused every hop."""

    def z(n: int) -> F32:
        return np.zeros(n, dtype=np.float32)

    return AudioFrame(
        index=0, sample_rate=0.0, host_time=0.0, onset=False, silent=True,
        scalars=z(N_SCALARS), bands=z(bands), spectrum=z(spectrum), waveform=z(waveform),
        left=z(waveform) if stereo else None, right=z(waveform) if stereo else None,
    )  # fmt: skip
