"""The Analyzer: one AudioFrame per hop from an ordered list of FeatureExtractors.

The Analyzer computes the shared per-hop inputs once (newest window, mono mix, Hann-windowed
magnitude spectrum) into an :class:`AnalysisContext`, then runs each extractor in order. Every
array is allocated in ``__init__``; the hot path writes through ``out=`` arguments only.
"""

from typing import Protocol

import numpy as np

from tidalviz.analysis.settings import AnalysisSettings
from tidalviz.capture.ring import RingBuffer
from tidalviz.frame import F32, AudioFrame, new_frame


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
        self.n_bins = n // 2 + 1
        self.bin_hz = sample_rate / n
        self.freqs: F32 = np.fft.rfftfreq(n, 1.0 / sample_rate).astype(np.float32)
        self.window: F32 = np.hanning(n).astype(np.float32)
        # Scale |rfft| so a full-scale sine reads 1.0 at its peak bin.
        self.mag_scale = 2.0 / float(np.sum(self.window))
        self.pcm: F32 = np.zeros((n, channels), dtype=np.float32)  # newest window, oldest first
        self.mono: F32 = np.zeros(n, dtype=np.float32)
        # float64 FFT: with out= numpy's pocketfft needs no scratch (float32 input allocates
        # ~34 KB per call) and it is slightly faster (5.7 vs 6.7 µs for 2048 points on M1).
        self.windowed = np.zeros(n, dtype=np.float64)
        self.spec = np.zeros(self.n_bins, dtype=np.complex128)
        self._mag64 = np.zeros(self.n_bins, dtype=np.float64)
        self.mag: F32 = np.zeros(self.n_bins, dtype=np.float32)  # linear amplitude, not gained
        self.gain = 1.0  # auto-gain factor for display features (set by AutoGain)
        self.silent = True  # set by Level
        # Tilted band levels on the 0–1 display scale, unclipped (floored at −10 dB below 0).
        self.band_level = np.zeros(settings.n_bands, dtype=np.float64)  # set by Bands
        self.hop_ms = 0.0  # mean square of the newest hop (set by Level)
        self.mag_sum = 0.0  # Σ mag (set by Centroid, read by Flux)
        self.odf = 0.0  # onset detection function value this hop (set by Onset, read by Tempo)
        self.onset = False  # set by Onset
        self.onset_time = 0.0  # host time of the latest onset, sub-hop accurate (set by Onset)
        self.index = 0
        self.host_time = 0.0

    def load(self, ring: RingBuffer, host_time: float) -> None:
        self.host_time = host_time
        ring.latest(self.fft_size, self.pcm)
        # Channel sum with explicit ufuncs: np.mean(axis=1) allocates a temporary.
        np.copyto(self.mono, self.pcm[:, 0])
        for c in range(1, self.channels):
            np.add(self.mono, self.pcm[:, c], out=self.mono)
        if self.channels > 1:
            np.multiply(self.mono, np.float32(1.0 / self.channels), out=self.mono)
        np.multiply(self.mono, self.window, out=self.windowed)
        np.fft.rfft(self.windowed, out=self.spec)
        np.abs(self.spec, out=self._mag64)  # same-dtype out: a casting ufunc would buffer 8 KB
        np.multiply(self._mag64, self.mag_scale, out=self._mag64)
        np.copyto(self.mag, self._mag64)


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
