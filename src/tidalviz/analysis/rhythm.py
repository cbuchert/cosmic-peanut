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


class Tempo:
    """Tempo from the autocorrelation of the onset envelope; beat phase from a phase-locked loop.

    Every ``UPDATE`` frames the last ~5.5 s of the onset detection function is autocorrelated
    (via a zero-padded FFT into preallocated buffers). Candidate periods between 60 and 180 BPM
    are scored with their first harmonics and a log-normal prior around 120 BPM (to avoid
    octave errors), then refined to a fractional lag by parabolic interpolation over the first
    few multiples. ``bpm`` is reported once consecutive estimates agree.

    Beat phase: a comb over the envelope gives the initial beat alignment; after that, every
    (sub-hop localized) onset near a predicted beat nudges the reference beat time toward it.
    """

    fields: tuple[str, ...] = ("bpm", "beatPhase")
    HISTORY = 512  # frames of onset envelope (5.5 s at 48 kHz / 512)
    UPDATE = 8  # frames between tempo estimates
    MIN_BPM, MAX_BPM, PRIOR_BPM, PRIOR_OCTAVES = 60.0, 180.0, 120.0, 1.0
    CONFIDENCE = 0.2  # ACF peak / ACF[0]
    AGREE = 0.02  # relative agreement between consecutive estimates
    AGREE_COUNT = 3
    LOSE_AFTER = 12  # updates without confidence before bpm drops back to 0 (~1 s)
    PLL_WINDOW, PLL_GAIN = 0.2, 0.25  # onsets within ±0.2 beat pull the phase by 25%

    def __init__(self, ctx: AnalysisContext) -> None:
        h = self.HISTORY
        self._fps = 1.0 / ctx.dt
        self._env: F32 = np.zeros(h, dtype=np.float32)  # circular
        self._pos = 0
        self._frames = 0
        # float64/complex128 throughout: numpy's FFT then needs no scratch allocations.
        self._lin = np.zeros(2 * h, dtype=np.float64)  # time-ordered, zero padded
        self._spec = np.zeros(h + 1, dtype=np.complex128)
        self._pow = np.zeros(h + 1, dtype=np.float64)
        self._acf = np.zeros(2 * h, dtype=np.float64)
        self._acfm = np.zeros(2 * h, dtype=np.float64)  # 3-tap max of _acf
        lo = math.floor(self._fps * 60.0 / self.MAX_BPM)
        hi = math.ceil(self._fps * 60.0 / self.MIN_BPM)
        self._lags = np.arange(lo, hi + 1)
        bpm = 60.0 * self._fps / self._lags
        self._prior = np.exp(-0.5 * (np.log2(bpm / self.PRIOR_BPM) / self.PRIOR_OCTAVES) ** 2)
        self._score = np.zeros(self._lags.size, dtype=np.float64)
        self._tmp = np.zeros(self._lags.size, dtype=np.float64)
        self._period_s = 0.0  # 0 = not confident
        self._candidate = 0.0
        self._agree = 0
        self._misses = 0
        self._ref = 0.0  # host time of a reference beat
        self._last_onset = -1.0
        self._i_bpm = SCALAR_INDEX["bpm"]
        self._i_phase = SCALAR_INDEX["beatPhase"]

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        self._env[self._pos] = ctx.odf
        self._pos = (self._pos + 1) % self.HISTORY
        self._frames += 1
        if self._frames >= self.HISTORY // 2 and self._frames % self.UPDATE == 0:
            self._estimate(ctx)
        if self._period_s > 0.0 and ctx.onset and ctx.onset_time != self._last_onset:
            self._pull_phase(ctx.onset_time)
        self._last_onset = ctx.onset_time if ctx.onset else self._last_onset
        if self._period_s > 0.0:
            out.scalars[self._i_bpm] = 60.0 / self._period_s
            out.scalars[self._i_phase] = ((ctx.host_time - self._ref) / self._period_s) % 1.0
        else:
            out.scalars[self._i_bpm] = 0.0
            out.scalars[self._i_phase] = 0.0

    def _ordered(self) -> None:
        """Copy the envelope oldest-first into _lin[:H], mean-removed; _lin[H:] stays 0."""
        h, p = self.HISTORY, self._pos
        self._lin[: h - p] = self._env[p:]
        self._lin[h - p : h] = self._env[:p]
        body = self._lin[:h]
        np.subtract(body, float(np.mean(body)), out=body)

    def _estimate(self, ctx: AnalysisContext) -> None:
        h = self.HISTORY
        self._ordered()
        np.fft.rfft(self._lin, out=self._spec)
        np.abs(self._spec, out=self._pow)
        np.square(self._pow, out=self._pow)
        self._spec.imag[:] = 0.0  # |X|² as a complex array: irfft of a real array would cast
        self._spec.real[:] = self._pow
        np.fft.irfft(self._spec, n=2 * h, out=self._acf)
        acf = self._acf
        zero = float(acf[0])
        if zero <= 1e-12:
            self._miss()
            return
        # score(L) = acf[L] + ½·acf[2L] (a true beat period also repeats at twice the lag),
        # read through a 3-tap max so periods that fall between whole frames aren't penalized.
        m = self._acfm
        np.maximum(acf[:-2], acf[1:-1], out=m[1:-1])
        np.maximum(m[1:-1], acf[2:], out=m[1:-1])
        lags = self._lags
        np.take(m, lags, out=self._score)
        np.take(m, 2 * lags, out=self._tmp)
        np.multiply(self._tmp, 0.5, out=self._tmp)
        np.add(self._score, self._tmp, out=self._score)
        np.multiply(self._score, self._prior, out=self._score)
        best = int(lags[int(np.argmax(self._score))])
        if m[best] / zero < self.CONFIDENCE:
            self._miss()
            return
        period = self._refine(best)
        self._misses = 0
        if self._candidate and abs(period - self._candidate) / self._candidate < self.AGREE:
            self._agree += 1
            self._candidate += 0.5 * (period - self._candidate)
        else:
            self._candidate, self._agree = period, 1
        if self._agree >= self.AGREE_COUNT:
            first = self._period_s == 0.0
            self._period_s = self._candidate / self._fps
            if first:
                self._ref = self._comb_phase(ctx)

    def _refine(self, lag: int) -> float:
        """Fractional period (frames) from parabolic peaks at lag, 2·lag, … weighted by multiple."""
        acf, total, weight = self._acf, 0.0, 0.0
        m = 1
        while (m + 1) * lag < self.HISTORY and m <= 4:
            c = round(m * lag)
            lo, hi = max(1, c - m), c + m
            k = lo + int(np.argmax(acf[lo : hi + 1]))
            a, b, d = float(acf[k - 1]), float(acf[k]), float(acf[k + 1])
            den = a - 2 * b + d
            frac = 0.5 * (a - d) / den if den < 0 else 0.0
            total += k + frac  # peak_m ≈ m·period, so Σpeak / Σm weights by multiple
            weight += m
            m += 1
        return total / weight if weight else float(lag)

    def _comb_phase(self, ctx: AnalysisContext) -> float:
        """Host time of the most recent beat, from a comb over the onset envelope."""
        period = self._period_s * self._fps
        h = self.HISTORY
        env = self._lin[:h]  # time-ordered (from _estimate), newest last
        n_beats = int((h - period) // period)
        best, best_score = 0, -1.0
        for phi in range(math.ceil(period)):
            idx = h - 1 - phi - np.round(np.arange(n_beats) * period).astype(np.int64)
            score = float(np.sum(env[idx]))
            if score > best_score:
                best, best_score = phi, score
        # The envelope peaks on the frame that detected the onset, about half a hop late.
        return ctx.host_time - (best + 0.5) * ctx.dt

    def _pull_phase(self, onset_time: float) -> None:
        p = self._period_s
        err = ((onset_time - self._ref) / p + 0.5) % 1.0 - 0.5  # beats; 0 = on a beat
        if abs(err) < self.PLL_WINDOW:
            self._ref += self.PLL_GAIN * err * p

    def _miss(self) -> None:
        self._misses += 1
        self._agree = 0
        self._candidate = 0.0
        if self._misses >= self.LOSE_AFTER:
            self._period_s = 0.0
