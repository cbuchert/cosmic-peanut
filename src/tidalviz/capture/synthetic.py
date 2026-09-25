"""Deterministic synthetic sources for tests, demo mode and benchmarks.

Kinds:
- ``sine1k``: a 0.5-amplitude 1 kHz sine.
- ``click120``: broadband clicks at exactly 120 BPM, the first at 0.25 s
  (:meth:`SyntheticSource.click_positions` gives the exact onset samples).
- ``demo``: a 120 BPM loop with kick, snare, hats, bass and a pad — music-like input.
- ``silence``: zeros.

Every sample is a pure function of its absolute index, so ``render(n)`` is deterministic.
"""

import numpy as np
from numpy.typing import NDArray

from tidalviz.capture.paced import PacedSource
from tidalviz.frame import F32

KINDS = ("sine1k", "click120", "demo", "silence")
BPM = 120.0
CLICK_OFFSET_S = 0.25

F64 = NDArray[np.float64]
I64 = NDArray[np.int64]


def _decay(n: int, sr: float, tau: float) -> F64:
    return np.exp(-np.arange(n) / (tau * sr))


class SyntheticSource(PacedSource):
    def __init__(
        self,
        kind: str,
        *,
        sample_rate: float = 48000.0,
        channels: int = 2,
        realtime: bool = True,
    ) -> None:
        if kind not in KINDS:
            raise ValueError(f"unknown synthetic source {kind!r}; expected one of {KINDS}")
        super().__init__(sample_rate, channels, realtime=realtime)
        self.kind = kind
        self.name = f"Synthetic ({kind})"
        sr = sample_rate
        self.beat_period = round(sr * 60.0 / BPM)  # samples; exact at 48 kHz (24000)
        self.click_offset = round(sr * CLICK_OFFSET_S)
        rng = np.random.default_rng(1234)
        n_click = int(0.02 * sr)
        self._click: F64 = (
            0.9 * rng.choice(np.array([-1.0, 1.0]), n_click) * _decay(n_click, sr, 0.003)
        )
        n_kick = int(0.3 * sr)
        tk = np.arange(n_kick) / sr
        freq = 50.0 + 100.0 * np.exp(-tk / 0.03)
        self._kick: F64 = 0.8 * np.sin(2 * np.pi * np.cumsum(freq) / sr) * _decay(n_kick, sr, 0.12)
        n_snare = int(0.2 * sr)
        self._snare: F64 = 0.35 * rng.standard_normal(n_snare) * _decay(n_snare, sr, 0.05)
        n_hat = int(0.05 * sr)
        hat = np.diff(rng.standard_normal(n_hat + 1))  # differentiated noise ≈ high-passed
        self._hat: F64 = 0.12 * hat * _decay(n_hat, sr, 0.012)

    def click_positions(self, n: int) -> list[int]:
        """Sample indices (< n) where ``click120`` clicks start."""
        return list(range(self.click_offset, n, self.beat_period))

    def _generate(self, i: I64) -> F32:
        sr = self.format.sample_rate
        if self.kind == "sine1k":
            mono = 0.5 * np.sin(2 * np.pi * 1000.0 * (i / sr))
        elif self.kind == "click120":
            mono = _events(i, self._click, self.click_offset, self.beat_period)
        elif self.kind == "demo":
            mono = self._demo(i)
        else:
            mono = np.zeros(i.shape[0])
        out = np.empty((i.shape[0], self.format.channels), dtype=np.float32)
        out[:] = mono[:, None]
        return out

    def _demo(self, i: I64) -> F64:
        sr = self.format.sample_rate
        beat = self.beat_period
        t = i / sr
        kick = _events(i, self._kick, 0, beat)
        snare = _events(i, self._snare, beat, 2 * beat)
        hats = _events(i, self._hat, beat // 2, beat)
        bar = (i // (4 * beat)) % 4
        root = np.array([55.0, 43.65, 49.0, 41.2])[bar]  # A1 F1 G1 E1
        bass = 0.18 * np.sign(np.sin(2 * np.pi * root * t)) * (0.6 + 0.4 * np.cos(np.pi * t * 4))
        pad = np.zeros_like(t)
        for m in (4.0, 5.04, 6.0, 8.0):
            pad += 0.05 * np.sin(2 * np.pi * root * m * t)
        return 0.9 * np.tanh(kick + snare + hats + bass + pad)  # soft clip into (-0.9, 0.9)


def _events(i: I64, template: F64, offset: int, period: int) -> F64:
    """``template`` started at ``offset + k * period`` for every k >= 0."""
    n = len(template)
    age = i - offset
    age = np.where(age >= 0, age % period, n)
    padded = np.append(template, 0.0)
    return padded[np.minimum(age, n)]
