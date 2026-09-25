"""Feature extractors. Each declares the fields it writes and allocates only in ``__init__``."""

import math

import numpy as np

from tidalviz.analysis.analyzer import AnalysisContext, FeatureExtractor
from tidalviz.frame import F32, N_SPECTRUM, N_WAVEFORM, SCALAR_INDEX, AudioFrame

SILENCE_RMS = 10 ** (-70 / 20)  # −70 dBFS: macOS delivers exact zeros without permission


def smoothing(dt: float, tau: float) -> float:
    """One-pole coefficient: y += (x − y) · k reaches 63% of a step after ``tau`` seconds."""
    return 1.0 - math.exp(-dt / tau)


class Level:
    """rms and peak of the newest hop (raw, not gained), and the per-frame silent flag."""

    fields: tuple[str, ...] = ("rms", "peak", "silent")

    def __init__(self, ctx: AnalysisContext) -> None:
        self._abs: F32 = np.zeros((ctx.hop, ctx.channels), dtype=np.float32)
        self._sq: F32 = np.zeros(ctx.hop, dtype=np.float32)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        np.square(ctx.mono[-ctx.hop :], out=self._sq)
        rms = math.sqrt(float(np.mean(self._sq)))
        np.abs(ctx.pcm[-ctx.hop :], out=self._abs)
        peak = float(np.max(self._abs))
        out.scalars[SCALAR_INDEX["rms"]] = rms
        out.scalars[SCALAR_INDEX["peak"]] = peak
        ctx.silent = out.silent = rms < SILENCE_RMS


class AutoGain:
    """Slow loudness normalization: ctx.gain brings the long-term rms toward −20 dBFS.

    It holds during silence so a pause doesn't blow the gain up. Display features (spectrum,
    bands) multiply by ctx.gain; level scalars stay raw.
    """

    fields: tuple[str, ...] = ()
    TARGET_RMS = 0.1
    MIN_GAIN, MAX_GAIN = 0.1, 30.0

    def __init__(self, ctx: AnalysisContext) -> None:
        self.enabled = ctx.settings.auto_gain
        self._k_slow = smoothing(ctx.dt, 5.0)
        self._k_fast = smoothing(ctx.dt, 0.3)
        self._ms = 0.0  # tracked mean square
        self._frames = 0  # non-silent frames seen
        self._warmup = int(2.0 / ctx.dt)
        self._sq: F32 = np.zeros(ctx.hop, dtype=np.float32)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        if not self.enabled:
            ctx.gain = 1.0
            return
        if ctx.silent:
            return
        np.square(ctx.mono[-ctx.hop :], out=self._sq)
        ms = float(np.mean(self._sq))
        k = self._k_fast if self._frames < self._warmup else self._k_slow
        self._ms = ms if self._frames == 0 else self._ms + (ms - self._ms) * k
        self._frames += 1
        g = self.TARGET_RMS / max(math.sqrt(self._ms), 1e-9)
        ctx.gain = min(max(g, self.MIN_GAIN), self.MAX_GAIN)


class Waveform:
    """Newest 512 samples: mono mix, plus left/right planes when stereo."""

    fields: tuple[str, ...] = ("waveform", "left", "right")

    def __init__(self, ctx: AnalysisContext) -> None:
        pass

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        np.copyto(out.waveform, ctx.mono[-N_WAVEFORM:])
        if out.left is not None and out.right is not None and ctx.channels >= 2:
            np.copyto(out.left, ctx.pcm[-N_WAVEFORM:, 0])
            np.copyto(out.right, ctx.pcm[-N_WAVEFORM:, 1])


class Spectrum:
    """1024-bin linear magnitude (gained, clipped 0–1). FFT 4096 folds bin pairs by max."""

    fields: tuple[str, ...] = ("spectrum",)

    def __init__(self, ctx: AnalysisContext) -> None:
        self._fold = (ctx.n_bins - 1) // N_SPECTRUM  # 1 for FFT 2048, 2 for 4096

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        body = ctx.mag[: N_SPECTRUM * self._fold]
        if self._fold == 1:
            np.multiply(body, ctx.gain, out=out.spectrum)
        else:
            np.max(body.reshape(N_SPECTRUM, self._fold), axis=1, out=out.spectrum)
            np.multiply(out.spectrum, ctx.gain, out=out.spectrum)
        np.clip(out.spectrum, 0.0, 1.0, out=out.spectrum)


class Bands:
    """64 log-spaced bands: power density → dB with a pink tilt → 0–1, fast attack/slow release.

    Each band is the mean power per FFT bin over its frequency range (bins partially inside a
    band count by their overlap, so narrow bass bands still get a value). Adding +3 dB/octave
    (relative to 1 kHz) makes pink noise read flat across bands.
    """

    fields: tuple[str, ...] = ("bands",)
    TILT_DB_PER_OCTAVE = 3.0
    DB_FLOOR, DB_CEIL = -70.0, -10.0
    ATTACK_S, RELEASE_S = 0.01, 0.3

    def __init__(self, ctx: AnalysisContext) -> None:
        s = ctx.settings
        self.edges = np.geomspace(s.band_low_hz, s.band_high_hz, s.n_bands + 1)
        self.weights = _band_weights(self.edges, ctx.n_bins, ctx.bin_hz)
        centers = np.sqrt(self.edges[:-1] * self.edges[1:])
        self._tilt: F32 = (self.TILT_DB_PER_OCTAVE * np.log2(centers / 1000.0)).astype(np.float32)
        self._power: F32 = np.zeros(ctx.n_bins, dtype=np.float32)
        self._level: F32 = np.zeros(s.n_bands, dtype=np.float32)
        self._coef: F32 = np.zeros(s.n_bands, dtype=np.float32)
        self._rising = np.zeros(s.n_bands, dtype=np.bool_)
        self._state: F32 = np.zeros(s.n_bands, dtype=np.float32)
        self._k_attack = smoothing(ctx.dt, self.ATTACK_S)
        self._k_release = smoothing(ctx.dt, self.RELEASE_S)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        lv = self._level
        np.square(ctx.mag, out=self._power)
        np.dot(self.weights, self._power, out=lv)
        np.multiply(lv, ctx.gain * ctx.gain, out=lv)
        np.add(lv, 1e-12, out=lv)
        np.log10(lv, out=lv)
        np.multiply(lv, 10.0, out=lv)
        np.add(lv, self._tilt, out=lv)
        np.subtract(lv, self.DB_FLOOR, out=lv)
        np.multiply(lv, 1.0 / (self.DB_CEIL - self.DB_FLOOR), out=lv)
        np.clip(lv, 0.0, 1.0, out=lv)
        # state += (level − state) · (attack if rising else release)
        np.greater(lv, self._state, out=self._rising)
        np.multiply(self._rising, self._k_attack - self._k_release, out=self._coef)
        np.add(self._coef, self._k_release, out=self._coef)
        np.subtract(lv, self._state, out=lv)
        np.multiply(lv, self._coef, out=lv)
        np.add(self._state, lv, out=self._state)
        np.copyto(out.bands, self._state)


class BassMidTreb:
    """MilkDrop-style bass/mid/treb: 1.0 = that range's average over the last few seconds.

    Each range's immediate level is the summed (ungained) magnitude of its bins, divided by a
    slow average of itself, so values run roughly 0–2 whatever the loudness. ``*Att`` divides a
    smoothed (~150 ms) level by the same average. Silence reads 0 and does
    not disturb the averages.
    """

    fields: tuple[str, ...] = ("bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt")
    RANGES_HZ = ((20.0, 250.0), (250.0, 4000.0), (4000.0, 16000.0))
    AVERAGE_S, WARMUP_AVERAGE_S, WARMUP_S = 4.0, 0.5, 1.5
    ATT_S = 0.15  # symmetric, so *Att also averages 1.0
    MAX_VALUE = 10.0  # safety cap only; sharp hats legitimately read 4–6

    def __init__(self, ctx: AnalysisContext) -> None:
        self._slices = [
            slice(math.ceil(lo / ctx.bin_hz), min(math.ceil(hi / ctx.bin_hz), ctx.n_bins))
            for lo, hi in self.RANGES_HZ
        ]
        self._idx = [SCALAR_INDEX[n] for n in self.fields]
        self._long = [0.0, 0.0, 0.0]
        self._att = [0.0, 0.0, 0.0]
        self._frames = 0
        self._warmup = int(self.WARMUP_S / ctx.dt)
        self._k_long = smoothing(ctx.dt, self.AVERAGE_S)
        self._k_warm = smoothing(ctx.dt, self.WARMUP_AVERAGE_S)
        self._k_att = smoothing(ctx.dt, self.ATT_S)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        sc = out.scalars
        if ctx.silent:
            for i in self._idx:
                sc[i] = 0.0
            self._att = [0.0, 0.0, 0.0]
            return
        k_long = self._k_warm if self._frames < self._warmup else self._k_long
        self._frames += 1
        for r, sl in enumerate(self._slices):
            imm = float(np.sum(ctx.mag[sl]))
            long = imm if self._frames == 1 else self._long[r] + (imm - self._long[r]) * k_long
            att = self._att[r] + (imm - self._att[r]) * self._k_att
            self._long[r], self._att[r] = long, att
            denom = max(long, 1e-9)
            sc[self._idx[r]] = min(imm / denom, self.MAX_VALUE)
            sc[self._idx[r + 3]] = min(att / denom, self.MAX_VALUE)


def _band_weights(edges: np.ndarray, n_bins: int, bin_hz: float) -> F32:
    """(bands, bins) matrix; row b averages the power of the bins overlapping band b."""
    lo = (np.arange(n_bins) - 0.5) * bin_hz
    hi = lo + bin_hz
    w = np.zeros((len(edges) - 1, n_bins), dtype=np.float64)
    for b in range(len(edges) - 1):
        overlap = np.clip(np.minimum(hi, edges[b + 1]) - np.maximum(lo, edges[b]), 0.0, None)
        w[b] = overlap / overlap.sum()
    return w.astype(np.float32)


def default_extractors(ctx: AnalysisContext) -> list[FeatureExtractor]:
    return [Level(ctx), AutoGain(ctx), Waveform(ctx), Spectrum(ctx), Bands(ctx), BassMidTreb(ctx)]
