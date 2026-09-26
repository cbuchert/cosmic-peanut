"""The Analyzer: one AudioFrame per hop from an ordered list of FeatureExtractors.

The Analyzer computes the shared per-hop inputs once (newest window, mono mix, Hann-windowed
magnitude spectrum and a few spectral sums) into an :class:`AnalysisContext`, then runs each
extractor in order. Every array is allocated in ``__init__``; the hot path writes through
``out=`` arguments only.

Cost model: the analysis thread wakes every ~10.7 ms for well under a millisecond of work, so
it always runs on cold caches and each numpy call costs ~3–8 µs rather than ~1 µs. The hot
path is written to make as few numpy calls as possible: the window is a zero-copy view of the
ring, the frame's waveform planes are views of it, and centroid, flux and bass/mid/treb all
come from one small matrix product.
"""

from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from tidalviz.analysis.fft import rfft
from tidalviz.analysis.settings import AnalysisSettings
from tidalviz.capture.ring import RingBuffer
from tidalviz.frame import F32, AudioFrame, new_frame

F64 = NDArray[np.float64]

BASS_MID_TREB_HZ = ((20.0, 250.0), (250.0, 4000.0), (4000.0, 16000.0))

# Columns of AnalysisContext.sums, all from one matrix product per hop.
SUM_MAG, SUM_FREQ, SUM_BASS, SUM_MID, SUM_TREB = range(5)


class AnalysisContext:
    """Per-hop inputs shared by all extractors. Arrays are reused every hop."""

    def __init__(self, sample_rate: float, channels: int, settings: AnalysisSettings) -> None:
        n = settings.fft_size
        self.settings = settings
        self.sample_rate = sample_rate
        self.channels = channels
        self.hop = settings.hop
        self.dt = settings.hop / sample_rate  # seconds per frame
        self.fft_size = n
        self.n_bins = nb = n // 2 + 1
        self.bin_hz = sample_rate / n
        self.freqs: F32 = np.fft.rfftfreq(n, 1.0 / sample_rate).astype(np.float32)
        # Hann window with the magnitude scale folded in (a full-scale sine reads 1.0 at its
        # peak bin). float32 like the samples, so the product is computed in float32 and only
        # cast into the float64 FFT input (with out= numpy's pocketfft then needs no scratch).
        hann = np.hanning(n)
        self.window: F32 = (hann * (2.0 / float(np.sum(hann)))).astype(np.float32)
        self._mix: F32 = np.full(channels, 1.0 / channels, dtype=np.float32)
        self.pcm: F32 = np.zeros((channels, n), dtype=np.float32)  # planar; a ring view per hop
        self.mono: F32 = np.zeros(n, dtype=np.float32)  # pcm[0] itself when mono
        self.windowed: F64 = np.zeros(n, dtype=np.float64)
        self.spec = np.zeros(nb, dtype=np.complex128)
        # Rows 0 and 1 alternate as this hop's and the previous hop's magnitude (no copy); row 2
        # is their elementwise minimum, for flux. Linear amplitude, not gained.
        self._mags: F64 = np.zeros((3, nb), dtype=np.float64)
        self.mag: F64 = self._mags[0]
        self.prev_mag: F64 = self._mags[1]
        # (bins, 5): ones, frequency / Nyquist, and the bass, mid and treble bin masks.
        cols = np.zeros((nb, 5), dtype=np.float64)
        cols[:, SUM_MAG] = 1.0
        cols[:, SUM_FREQ] = self.freqs / (sample_rate / 2)
        for c, (lo, hi) in zip((SUM_BASS, SUM_MID, SUM_TREB), BASS_MID_TREB_HZ, strict=True):
            cols[int(np.ceil(lo / self.bin_hz)) : min(int(np.ceil(hi / self.bin_hz)), nb), c] = 1
        self._cols = cols
        self._sums: F64 = np.zeros((3, 5), dtype=np.float64)
        self.sums: F64 = self._sums[0]  # Σ mag · column, this hop (SUM_* indices)
        self.prev_sums: F64 = self._sums[1]  # the same for the previous hop
        self.sum_min = 0.0  # Σ min(mag, prev_mag)
        self.gain = 1.0  # auto-gain factor for display features (set by AutoGain)
        self.silent = True  # set by Level
        # Tilted band levels on the 0–1 display scale, unclipped (floored at −10 dB below 0).
        self.band_level: F64 = np.zeros(settings.n_bands, dtype=np.float64)  # set by Bands
        self.prev_band_level: F64 = np.zeros(settings.n_bands, dtype=np.float64)  # last hop's
        self.hop_ms = 0.0  # mean square of the newest hop (set by Level)
        self.odf = 0.0  # onset detection function value this hop (set by Onset, read by Tempo)
        self.onset = False  # set by Onset
        self.onset_time = 0.0  # host time of the latest onset, sub-hop accurate (set by Onset)
        self.index = 0
        self.host_time = 0.0

    def load(self, ring: RingBuffer, host_time: float) -> None:
        self.host_time = host_time
        self.pcm = pcm = ring.view(self.fft_size)
        if self.channels == 1:
            self.mono = pcm[0]
        else:
            np.matmul(self._mix, pcm, out=self.mono)
        np.multiply(self.mono, self.window, out=self.windowed)
        rfft(self.windowed, self.spec)
        mags, sums = self._mags, self._sums
        cur = self.index & 1
        self.mag, self.prev_mag = mags[cur], mags[cur ^ 1]
        self.sums, self.prev_sums = sums[cur], sums[cur ^ 1]
        np.abs(self.spec, out=self.mag)
        np.minimum(mags[0], mags[1], out=mags[2])
        np.matmul(mags, self._cols, out=sums)
        self.sum_min = float(sums[2, SUM_MAG])


class FeatureExtractor(Protocol):
    fields: tuple[str, ...]  # scalar names / frame arrays it writes

    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None: ...


class Analyzer:
    def __init__(
        self,
        sample_rate: float,
        channels: int,
        settings: AnalysisSettings | None = None,
        extractors: list[FeatureExtractor] | None = None,
    ) -> None:
        from tidalviz.analysis.features import default_extractors

        self.settings = settings or AnalysisSettings()
        self.ctx = AnalysisContext(sample_rate, channels, self.settings)
        self.extractors = extractors if extractors is not None else default_extractors(self.ctx)
        self.frame = new_frame(stereo=channels == 2)
        self.frame.sample_rate = sample_rate

    def process(self, ring: RingBuffer, host_time: float) -> AudioFrame:
        ctx, out = self.ctx, self.frame
        ctx.load(ring, host_time)
        out.host_time = host_time
        out.index = ctx.index
        for ex in self.extractors:
            ex.process(ctx, out)
        ctx.index += 1
        return out
