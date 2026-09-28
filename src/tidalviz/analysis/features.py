"""Feature extractors. Each declares the fields it writes and allocates only in ``__init__``."""

import math

import numpy as np

from tidalviz.analysis.analyzer import (
    BASS_MID_TREB_HZ,
    SUM_BASS,
    SUM_FREQ,
    SUM_MAG,
    AnalysisContext,
    FeatureExtractor,
)
from tidalviz.frame import F32, N_SPECTRUM, N_WAVEFORM, SCALAR_INDEX, AudioFrame

SILENCE_RMS = 10 ** (-70 / 20)  # −70 dBFS: macOS delivers exact zeros without permission


def smoothing(dt: float, tau: float) -> float:
    """One-pole coefficient: y += (x − y) · k reaches 63% of a step after ``tau`` seconds."""
    return 1.0 - math.exp(-dt / tau)


class Level:
    """rms and peak of the newest hop (raw, not gained), and the per-frame silent flag."""

    fields: tuple[str, ...] = ("rms", "peak", "silent")

    def __init__(self, ctx: AnalysisContext) -> None:
        self._i_rms = SCALAR_INDEX["rms"]
        self._i_peak = SCALAR_INDEX["peak"]

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        hop = ctx.mono[-ctx.hop :]
        ctx.hop_ms = float(np.dot(hop, hop)) / ctx.hop  # mean square, shared with AutoGain
        pcm = ctx.pcm[:, -ctx.hop :]
        peak = max(
            float(np.maximum.reduce(pcm, axis=None)), -float(np.minimum.reduce(pcm, axis=None))
        )
        rms = math.sqrt(ctx.hop_ms)
        out.scalars[self._i_rms] = rms
        out.scalars[self._i_peak] = peak
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

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        if not self.enabled:
            ctx.gain = 1.0
            return
        if ctx.silent:
            return
        ms = ctx.hop_ms
        k = self._k_fast if self._frames < self._warmup else self._k_slow
        self._ms = ms if self._frames == 0 else self._ms + (ms - self._ms) * k
        self._frames += 1
        g = self.TARGET_RMS / max(math.sqrt(self._ms), 1e-9)
        ctx.gain = min(max(g, self.MIN_GAIN), self.MAX_GAIN)


class Waveform:
    """Newest N_WAVEFORM (2048) samples: mono mix, plus left/right planes when stereo.

    The planes are views of this hop's window (no copy), valid until the next hop.
    """

    fields: tuple[str, ...] = ("waveform", "left", "right")

    def __init__(self, ctx: AnalysisContext) -> None:
        pass

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        out.waveform = ctx.mono[-N_WAVEFORM:]
        if out.left is not None and out.right is not None and ctx.channels >= 2:
            out.left = ctx.pcm[0, -N_WAVEFORM:]
            out.right = ctx.pcm[1, -N_WAVEFORM:]


class Spectrum:
    """1024-bin linear magnitude (gained, clipped 0–1). FFT 4096 folds bin pairs by max."""

    fields: tuple[str, ...] = ("spectrum",)

    def __init__(self, ctx: AnalysisContext) -> None:
        self._fold = (ctx.n_bins - 1) // N_SPECTRUM  # 1 for FFT 2048, 2 for 4096
        self._folded: F32 = np.zeros(N_SPECTRUM, dtype=np.float32)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        body = ctx.mag[: N_SPECTRUM * self._fold]
        if self._fold != 1:
            body = np.maximum.reduce(body.reshape(N_SPECTRUM, self._fold), axis=1, out=self._folded)
        np.multiply(body, ctx.gain, out=out.spectrum)
        np.minimum(out.spectrum, 1.0, out=out.spectrum)  # magnitudes are never negative


class Bands:
    """64 log-spaced bands: power density → dB with a pink tilt → 0–1, fast attack/slow release.

    Each band is the mean power per FFT bin over its frequency range (bins partially inside a
    band count by their overlap, so narrow bass bands still get a value). Adding +3 dB/octave
    (relative to 1 kHz) makes pink noise read flat across bands.
    """

    fields: tuple[str, ...] = ("bands",)
    TILT_DB_PER_OCTAVE = 3.0
    DB_FLOOR, DB_CEIL = -70.0, -10.0
    RELEASE_S = 0.3  # attack is instant

    def __init__(self, ctx: AnalysisContext) -> None:
        s = ctx.settings
        nb = ctx.n_bins
        self.edges = np.geomspace(s.band_low_hz, s.band_high_hz, s.n_bands + 1)
        weights = _band_weights(self.edges, nb, ctx.bin_hz)
        centers = np.sqrt(self.edges[:-1] * self.edges[1:])
        tilt_db = self.TILT_DB_PER_OCTAVE * np.log2(centers / 1000.0)
        db_range = self.DB_CEIL - self.DB_FLOOR
        # level = (10·log10(g²·W·power + 1e-12) + tilt − floor) / range
        #       = scale · log10(c · (g²·W·power + 1e-12)),  c = 10^((tilt − floor) / 10)
        # so the per-band offset folds into the weights. The weights are sparse (each band
        # covers a few bins): one take + multiply + reduceat instead of a 64 × 1025 product.
        # A constant 1.0 after the last bin carries the 1e-12 floor into each band's sum.
        self._scale = np.float32(10.0 / db_range)
        c = 10.0 ** ((tilt_db - self.DB_FLOOR) / 10.0)
        idx: list[np.ndarray] = []
        wts: list[np.ndarray] = []
        starts = np.zeros(s.n_bands, dtype=np.intp)
        pos = 0
        for b in range(s.n_bands):
            (bins,) = np.nonzero(weights[b])
            starts[b] = pos
            idx += [bins, np.array([nb])]
            wts += [weights[b, bins] * c[b], np.array([1e-12 * c[b]])]
            pos += bins.size + 1
        self._idx = np.concatenate(idx).astype(np.intp)
        self._wts: F32 = np.concatenate(wts).astype(np.float32)
        self._starts = starts
        self._vals: F32 = np.zeros(self._idx.size, dtype=np.float32)
        self._power: F32 = np.ones(nb + 1, dtype=np.float32)  # [nb] stays 1.0
        self._x: F32 = np.zeros(s.n_bands, dtype=np.float32)
        self._lv: F32 = np.zeros(s.n_bands, dtype=np.float32)
        self._level_floor = np.float32(-10.0 / db_range)  # Onset sees down to floor − 10 dB
        self._decay = np.float32(math.exp(-ctx.dt / self.RELEASE_S))
        # Two level buffers alternate so Onset can compare against the previous hop, no copy.
        self._levels: F32 = np.zeros((2, s.n_bands), dtype=np.float32)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        power, x, lv = self._power[:-1], self._x, self._lv
        cur = ctx.index & 1
        level = ctx.band_level = self._levels[cur]
        ctx.prev_band_level = self._levels[cur ^ 1]
        np.multiply(ctx.mag, ctx.gain, out=power)
        np.square(power, out=power)
        np.take(self._power, self._idx, out=self._vals)
        np.multiply(self._vals, self._wts, out=self._vals)
        np.add.reduceat(self._vals, self._starts, out=x)
        np.log10(x, out=x)
        np.multiply(x, self._scale, out=x)
        np.maximum(x, self._level_floor, out=level)  # tilted, unclipped: Onset's input
        np.minimum(x, 1.0, out=lv)
        # Instant attack, exponential release, on the frame's own array (never above 1, and
        # never below 0 because it starts at 0): bands = max(min(level, 1), bands · decay).
        bands = out.bands
        np.multiply(bands, self._decay, out=bands)
        np.maximum(bands, lv, out=bands)


class BassMidTreb:
    """MilkDrop-style bass/mid/treb: 1.0 = that range's average over the last few seconds.

    Each range's immediate level is the summed (ungained) magnitude of its bins, divided by a
    slow average of itself, so values run roughly 0–2 whatever the loudness. ``*Att`` divides a
    smoothed (~150 ms) level by the same average. Silence reads 0 and does
    not disturb the averages.
    """

    fields: tuple[str, ...] = ("bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt")
    RANGES_HZ = BASS_MID_TREB_HZ  # summed by AnalysisContext.load (SUM_BASS …)
    AVERAGE_S = 4.0
    ATT_S = 0.15  # symmetric, so *Att also averages 1.0
    MAX_VALUE = 10.0  # safety cap only; sharp hats legitimately read 4–6

    def __init__(self, ctx: AnalysisContext) -> None:
        self._idx = [SCALAR_INDEX[n] for n in self.fields]
        self._long = [0.0, 0.0, 0.0]
        self._att = [0.0, 0.0, 0.0]
        self._frames = 0
        self._k_long = smoothing(ctx.dt, self.AVERAGE_S)
        self._k_att = smoothing(ctx.dt, self.ATT_S)

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        sc = out.scalars
        if ctx.silent:
            for i in self._idx:
                sc[i] = 0.0
            self._att = [0.0, 0.0, 0.0]
            return
        self._frames += 1
        # A running mean until it would move slower than the EMA: no start-up bias.
        k_long = max(1.0 / self._frames, self._k_long)
        sums = ctx.sums
        for r in range(3):
            imm = float(sums[SUM_BASS + r])
            long = self._long[r] + (imm - self._long[r]) * k_long
            att = self._att[r] + (imm - self._att[r]) * self._k_att
            self._long[r], self._att[r] = long, att
            denom = max(long, 1e-9)
            sc[self._idx[r]] = min(imm / denom, self.MAX_VALUE)
            sc[self._idx[r + 3]] = min(att / denom, self.MAX_VALUE)


class Centroid:
    """Spectral centroid (magnitude-weighted mean frequency) as a fraction of Nyquist."""

    fields: tuple[str, ...] = ("centroid",)

    def __init__(self, ctx: AnalysisContext) -> None:
        self._i = SCALAR_INDEX["centroid"]

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        total = float(ctx.sums[SUM_MAG])
        c = float(ctx.sums[SUM_FREQ]) / total if total > 1e-9 else 0.0
        out.scalars[self._i] = 0.0 if ctx.silent else c


class Flux:
    """Normalized spectral change: Σ|Δmag| / (Σmag + Σprev mag), 0 (steady) – 1 (all new)."""

    fields: tuple[str, ...] = ("flux",)

    def __init__(self, ctx: AnalysisContext) -> None:
        self._i = SCALAR_INDEX["flux"]

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        # Σ|a − b| = Σa + Σb − 2·Σmin(a, b): all three sums come from AnalysisContext.load.
        denom = float(ctx.sums[SUM_MAG]) + float(ctx.prev_sums[SUM_MAG])
        diff = max(denom - 2.0 * ctx.sum_min, 0.0)
        out.scalars[self._i] = diff / denom if denom > 1e-9 else 0.0


def _band_weights(edges: np.ndarray, n_bins: int, bin_hz: float) -> np.ndarray:
    """(bands, bins) matrix; row b averages the power of the bins overlapping band b."""
    lo = (np.arange(n_bins) - 0.5) * bin_hz
    hi = lo + bin_hz
    w = np.zeros((len(edges) - 1, n_bins), dtype=np.float64)
    for b in range(len(edges) - 1):
        overlap = np.clip(np.minimum(hi, edges[b + 1]) - np.maximum(lo, edges[b]), 0.0, None)
        w[b] = overlap / overlap.sum()
    return w


def default_extractors(ctx: AnalysisContext) -> list[FeatureExtractor]:
    from tidalviz.analysis.rhythm import Onset, Tempo

    return [
        Level(ctx), AutoGain(ctx), Waveform(ctx), Spectrum(ctx), Bands(ctx), BassMidTreb(ctx),
        Onset(ctx), Tempo(ctx), Centroid(ctx), Flux(ctx),
    ]  # fmt: skip
