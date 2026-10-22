"""Onset detection (spectral flux + adaptive threshold) and tempo / beat-phase tracking."""

import math

import numpy as np

from tidalviz.analysis.analyzer import AnalysisContext
from tidalviz.analysis.fft import irfft, rfft
from tidalviz.frame import F32, SCALAR_INDEX, AudioFrame


class Onset:
    """Onsets from spectral flux against an adaptive threshold.

    The flux is the mean positive level (dB) change across the 64 log bands (from Bands), so a
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
        self._inv_nb = 1.0 / nb
        self._diff = np.zeros(nb, dtype=np.float32)
        # Recent flux as plain floats with a running sum: a numpy mean per hop costs more.
        self._hist = [0.0] * max(2, round(self.HISTORY_S / ctx.dt))
        self._hist_sum = 0.0
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
        np.subtract(ctx.band_level, ctx.prev_band_level, out=self._diff)
        np.maximum(self._diff, 0.0, out=self._diff)
        odf = 0.0 if ctx.silent else float(np.add.reduce(self._diff)) * self._inv_nb

        hist = self._hist
        threshold = self.THRESHOLD_RATIO * max(self._hist_sum, 0.0) / len(hist)
        threshold += self.THRESHOLD_FLOOR * self._peak
        self._hist_sum += odf - hist[self._hi]
        hist[self._hi] = odf
        self._hi = (self._hi + 1) % len(hist)
        if self._hi == 0:
            self._hist_sum = math.fsum(hist)  # no drift from the running sum
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
    few multiples. ``bpm`` is reported once consecutive estimates agree, and held until a
    second of silence (a weak estimate never drops it, so a beatless bridge keeps the tempo).

    Beat phase: a comb over the envelope gives the initial beat alignment. After that, a
    cumulative beat score (Stark, Davies & Plumbley, DAFx 2009, after Ellis 2007) keeps it:
    C(m) = (1 − α)·odf(m) + α·max_v W(v)·C(m − v) over v in ½–2 periods, W log-Gaussian around
    one period, so C peaks where onsets keep recurring a period apart, and a lone off-beat hit
    barely moves it. Once per beat the reference beat time is pulled toward C's latest peak.
    """

    fields: tuple[str, ...] = ("bpm", "beatPhase")
    HISTORY = 512  # frames of onset envelope (5.5 s at 48 kHz / 512)
    UPDATE = 8  # frames between tempo estimates
    MIN_BPM, MAX_BPM, PRIOR_BPM, PRIOR_OCTAVES = 60.0, 180.0, 120.0, 1.0
    CONFIDENCE = 0.2  # ACF peak / ACF[0]
    AGREE = 0.02  # relative agreement between consecutive estimates
    AGREE_COUNT = 3
    LOSE_S = 1.0  # seconds of silence before bpm drops back to 0 (beatless sound keeps it)
    HARMONICS = (1.0, 1.0, 1.0, 1.0)  # comb weights of the ACF at 1–4 × the candidate period
    THRESH_FRAMES = 16  # half-width of the moving mean taken off the envelope (0 = plain mean)
    ALPHA, TIGHTNESS = 0.9, 5.0  # cumulative score: weight of the past, width of W
    PULL = 0.5  # fraction of the phase error to C's peak corrected once per beat
    PEAK_GUARD = 2  # frames: C's newest values can still rise, so the peak search skips them

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
        lo = math.ceil(self._fps * 60.0 / self.MAX_BPM)
        hi = math.floor(self._fps * 60.0 / self.MIN_BPM)
        self._lags = np.arange(lo, hi + 1)
        bpm = 60.0 * self._fps / self._lags
        self._prior = np.exp(-0.5 * (np.log2(bpm / self.PRIOR_BPM) / self.PRIOR_OCTAVES) ** 2)
        self._score = np.zeros(self._lags.size, dtype=np.float64)
        # Comb: row (a, b) reads the ACF at a·lag + b, b within ±a (a period error grows with
        # the multiple); each harmonic's rows reduce to their max, then weigh by HARMONICS.
        rows = [a * self._lags + b for a in range(1, 5) for b in range(-a, a + 1)]
        self._comb_idx = np.clip(np.array(rows), 0, 2 * h - 1)
        self._comb_rows = np.zeros(self._comb_idx.shape, dtype=np.float64)
        self._comb_starts = np.array([0, 3, 8, 15])
        self._comb_max = np.zeros((4, self._lags.size), dtype=np.float64)
        self._comb_w = np.array(self.HARMONICS, dtype=np.float64)
        # Moving mean of the envelope via a cumulative sum (clamped windows at the ends).
        k, i = self.THRESH_FRAMES, np.arange(h)
        self._mm_hi, self._mm_lo = np.minimum(i + k + 1, h), np.maximum(i - k, 0)
        self._mm_n = (self._mm_hi - self._mm_lo).astype(np.float64)
        self._cum = np.zeros(h + 1, dtype=np.float64)
        self._mm = np.zeros(h, dtype=np.float64)
        self._mm_tmp = np.zeros(h, dtype=np.float64)
        self._period_s = 0.0  # 0 = not confident
        self._candidate = 0.0
        self._agree = 0
        self._silent = 0  # consecutive silent frames
        self._lose = round(self.LOSE_S * self._fps)
        self._ref = 0.0  # host time of a reference beat
        # Cumulative score, written at p and p + H so any recent span is one contiguous slice.
        self._cs = np.zeros(2 * h, dtype=np.float64)
        self._w = np.zeros(h, dtype=np.float64)  # W over lags hi..lo (oldest first, like a slice)
        self._wtmp = np.zeros(h, dtype=np.float64)
        self._lagv = np.arange(h, dtype=np.float64)  # lag v at index v
        self._wlo = self._whi = 0
        self._w_period = 0.0
        self._since_pull = 0
        self._i_bpm = SCALAR_INDEX["bpm"]
        self._i_phase = SCALAR_INDEX["beatPhase"]

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None:
        h, p = self.HISTORY, self._pos
        self._env[p] = ctx.odf
        c = ctx.odf
        if self._period_s > 0.0:
            c = (1.0 - self.ALPHA) * c + self.ALPHA * self._score_past()
        self._cs[p] = self._cs[p + h] = c
        self._pos = (p + 1) % h
        self._frames += 1
        self._silent = self._silent + 1 if ctx.silent else 0
        if self._silent >= self._lose:
            self._period_s = 0.0
            self._candidate, self._agree = 0.0, 0
        elif not ctx.silent and self._frames >= h // 2 and self._frames % self.UPDATE == 0:
            self._estimate(ctx)
        if self._period_s > 0.0:
            self._since_pull += 1
            if self._since_pull * ctx.dt >= self._period_s:
                self._pull_phase(ctx)
            out.scalars[self._i_bpm] = 60.0 / self._period_s
            out.scalars[self._i_phase] = ((ctx.host_time - self._ref) / self._period_s) % 1.0
        else:
            out.scalars[self._i_bpm] = 0.0
            out.scalars[self._i_phase] = 0.0

    def _score_past(self) -> float:
        """max_v W(v)·C(now − v), v from ½ to 2 periods (W rebuilt when the period changes)."""
        if self._period_s != self._w_period:
            self._set_window()
        lo, hi = self._wlo, self._whi
        end = self._pos + self.HISTORY  # C(now − v) is at end − v
        n = hi - lo + 1
        np.multiply(self._cs[end - hi : end - lo + 1], self._w[:n], out=self._wtmp[:n])
        return float(np.max(self._wtmp[:n]))

    def _set_window(self) -> None:
        period = self._period_s * self._fps
        self._wlo = max(1, round(period / 2))
        self._whi = min(self.HISTORY - 1, round(2 * period))
        w = self._w[: self._whi - self._wlo + 1]
        np.divide(self._lagv[self._whi : self._wlo - 1 : -1], period, out=w)  # hi..lo, a view
        np.log(w, out=w)
        np.square(w, out=w)
        np.multiply(w, -0.5 * self.TIGHTNESS**2, out=w)
        np.exp(w, out=w)
        self._w_period = self._period_s

    def _ordered(self) -> None:
        """Copy the envelope oldest-first into _lin[:H]; _lin[H:] stays 0.

        With THRESH_FRAMES, the moving mean is taken off and the rest half-wave rectified (an
        adaptive threshold: only peaks above the local level remain), then the mean removed.
        """
        h, p = self.HISTORY, self._pos
        self._lin[: h - p] = self._env[p:]
        self._lin[h - p : h] = self._env[:p]
        body = self._lin[:h]
        if self.THRESH_FRAMES:
            np.cumsum(body, out=self._cum[1:])
            np.take(self._cum, self._mm_hi, out=self._mm)
            np.take(self._cum, self._mm_lo, out=self._mm_tmp)
            np.subtract(self._mm, self._mm_tmp, out=self._mm)
            np.divide(self._mm, self._mm_n, out=self._mm)
            np.subtract(body, self._mm, out=body)
            np.maximum(body, 0.0, out=body)
        np.subtract(body, float(np.mean(body)), out=body)

    def _estimate(self, ctx: AnalysisContext) -> None:
        self._ordered()
        rfft(self._lin, self._spec)
        np.abs(self._spec, out=self._pow)
        np.square(self._pow, out=self._pow)
        self._spec.imag[:] = 0.0  # |X|² as a complex array: irfft of a real array would cast
        self._spec.real[:] = self._pow
        irfft(self._spec, self._acf)
        acf = self._acf
        zero = float(acf[0])
        if zero <= 1e-12:
            self._miss()
            return
        # score(L) = Σ_a HARMONICS[a]·max acf[a·L ± a] (a true beat period also repeats at its
        # multiples; the window lets periods between whole frames score fully), times the prior.
        m = self._acfm
        np.maximum(acf[:-2], acf[1:-1], out=m[1:-1])
        np.maximum(m[1:-1], acf[2:], out=m[1:-1])
        lags = self._lags
        np.take(acf, self._comb_idx, out=self._comb_rows)
        np.maximum.reduceat(self._comb_rows, self._comb_starts, axis=0, out=self._comb_max)
        np.matmul(self._comb_w, self._comb_max, out=self._score)
        np.multiply(self._score, self._prior, out=self._score)
        best = int(lags[int(np.argmax(self._score))])
        if m[best] / zero < self.CONFIDENCE:
            self._miss()
            return
        period = self._refine(best)
        if not self.MIN_BPM <= 60.0 * self._fps / period <= self.MAX_BPM:
            self._miss()  # refinement slid off the edge of the search range
            return
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

    def _pull_phase(self, ctx: AnalysisContext) -> None:
        """Pull the reference beat toward the cumulative score's peak over the last period."""
        self._since_pull = 0
        g, n = self.PEAK_GUARD, round(self._period_s * self._fps)
        end = self._pos + self.HISTORY - g  # exclusive; newest g frames skipped
        age = g + n - 1 - int(np.argmax(self._cs[end - n : end]))  # frames before the newest
        # C peaks on the frame that detected the onset, about half a hop late.
        beat = ctx.host_time - (age + 0.5) * ctx.dt
        err = ((beat - self._ref) / self._period_s + 0.5) % 1.0 - 0.5
        self._ref += self.PULL * err * self._period_s

    def _miss(self) -> None:
        """A weak estimate restarts the agreement count but keeps the current tempo."""
        self._agree = 0
        self._candidate = 0.0
