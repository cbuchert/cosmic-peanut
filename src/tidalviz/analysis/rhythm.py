"""Onset detection (spectral flux + adaptive threshold) and tempo / beat-phase tracking."""

import math

import numpy as np

from tidalviz.analysis.analyzer import AnalysisContext
from tidalviz.frame import F32, SCALAR_INDEX, AudioFrame


class Onset:
    """Onsets from spectral flux against an adaptive threshold.

    The flux is the mean positive dB change across the 64 log bands (computed by Bands), so a
    kick moving a few bass bins counts as much as a hat moving hundreds of treble bins.

    Detection is per hop; the onset's time is then localized inside the newest 2048 samples as
    the 64-sample block with the largest energy rise, so ``onsetAge`` (seconds from the onset to
    this frame's host_time) is accurate to ~1–3 ms rather than to a 10.7 ms hop. On frames
    without an onset ``onsetAge`` keeps growing (capped at 10 s; 10 before the first onset).
    """

    fields: tuple[str, ...] = ("onset", "onsetStrength", "onsetAge")
    HISTORY_S = 0.25  # adaptive threshold looks at this much recent flux
    THRESHOLD_RATIO, THRESHOLD_FLOOR = 1.5, 0.08  # × mean recent flux, + × running peak
    PEAK_DECAY_S = 3.0
    REFRACTORY_S = 0.05
    LOCALIZE_SAMPLES, LOCALIZE_BLOCK, LOCALIZE_LOOKBACK = 2048, 64, 8
    MAX_AGE_S = 10.0

    def __init__(self, ctx: AnalysisContext) -> None:
        nb = ctx.settings.n_bands
        self._prev: F32 = np.zeros(nb, dtype=np.float32)
        self._diff: F32 = np.zeros(nb, dtype=np.float32)
        self._hist: F32 = np.zeros(max(2, round(self.HISTORY_S / ctx.dt)), dtype=np.float32)
        self._hi = 0
        self._peak = 1e-6
        self._peak_decay = math.exp(-ctx.dt / self.PEAK_DECAY_S)
        self._refractory = round(self.REFRACTORY_S / ctx.dt)
        self._since = 1 << 30  # frames since the last onset
        self._above = False
        n_loc = min(self.LOCALIZE_SAMPLES, ctx.fft_size)
        self._loc_n = n_loc
        self._sq: F32 = np.zeros(n_loc, dtype=np.float32)
        self._energy: F32 = np.zeros(n_loc // self.LOCALIZE_BLOCK, dtype=np.float32)
        self._rise: F32 = np.zeros(
            n_loc // self.LOCALIZE_BLOCK - self.LOCALIZE_LOOKBACK, dtype=np.float32
        )
        self._i = SCALAR_INDEX["onsetStrength"]
        self._i_age = SCALAR_INDEX["onsetAge"]
        self._last_time: float | None = None

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        np.subtract(ctx.band_db, self._prev, out=self._diff)
        np.maximum(self._diff, 0.0, out=self._diff)
        odf = 0.0 if ctx.silent else float(np.mean(self._diff))
        np.copyto(self._prev, ctx.band_db)

        threshold = self.THRESHOLD_RATIO * float(np.mean(self._hist))
        threshold += self.THRESHOLD_FLOOR * self._peak
        self._hist[self._hi] = odf
        self._hi = (self._hi + 1) % self._hist.size
        self._peak = max(odf, self._peak * self._peak_decay, 1e-6)

        above = odf > threshold
        self._since += 1
        onset = above and not self._above and self._since > self._refractory
        self._above = above
        if onset:
            self._since = 0
            self._last_time = ctx.host_time - self._localize(ctx)
        ctx.odf = odf
        ctx.onset = out.onset = onset
        if self._last_time is not None:
            ctx.onset_time = self._last_time
        out.scalars[self._i] = min(odf / self._peak, 1.0)
        age = self.MAX_AGE_S if self._last_time is None else ctx.host_time - self._last_time
        out.scalars[self._i_age] = min(age, self.MAX_AGE_S)

    def _localize(self, ctx: AnalysisContext) -> float:
        """Seconds from the onset to the end of the newest sample.

        The onset is the 64-sample block whose energy most exceeds the maximum of the 8 blocks
        before it. Comparing against a max (not the previous block) ignores the energy ripple
        of steady low notes, whose period is shorter than the 512-sample lookback.
        """
        lb = self.LOCALIZE_LOOKBACK
        np.square(ctx.mono[-self._loc_n :], out=self._sq)
        np.sum(self._sq.reshape(-1, self.LOCALIZE_BLOCK), axis=1, out=self._energy)
        windows = np.lib.stride_tricks.sliding_window_view(self._energy[:-1], lb)
        np.max(windows, axis=1, out=self._rise)
        np.subtract(self._energy[lb:], self._rise, out=self._rise)
        k = int(np.argmax(self._rise)) + lb
        return (self._loc_n - k * self.LOCALIZE_BLOCK) / ctx.sample_rate
