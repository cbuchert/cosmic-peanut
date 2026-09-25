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
        self.mag_scale = np.float32(2.0 / float(np.sum(self.window)))
        self.pcm: F32 = np.zeros((n, channels), dtype=np.float32)  # newest window, oldest first
        self.mono: F32 = np.zeros(n, dtype=np.float32)
        self.windowed: F32 = np.zeros(n, dtype=np.float32)
        self.spec = np.zeros(self.n_bins, dtype=np.complex64)
        self.mag: F32 = np.zeros(self.n_bins, dtype=np.float32)  # linear amplitude, not gained
        self.gain = 1.0  # auto-gain factor for display features (set by AutoGain)
        self.silent = True  # set by Level
        self.band_db: F32 = np.zeros(settings.n_bands, dtype=np.float32)  # set by Bands
        self.odf = 0.0  # onset detection function value this hop (set by Onset, read by Tempo)
        self.onset = False  # set by Onset
        self.onset_time = 0.0  # host time of the latest onset, sub-hop accurate (set by Onset)
        self.index = 0
        self.host_time = 0.0

    def load(self, ring: RingBuffer, host_time: float) -> None:
        self.host_time = host_time
        ring.latest(self.fft_size, self.pcm)
        if self.channels == 1:
            np.copyto(self.mono, self.pcm[:, 0])
        else:
            np.mean(self.pcm, axis=1, out=self.mono)
        np.multiply(self.mono, self.window, out=self.windowed)
        np.fft.rfft(self.windowed, out=self.spec)  # numpy ≥ 2: float32 in, complex64 out, no alloc
        np.abs(self.spec, out=self.mag)
        np.multiply(self.mag, self.mag_scale, out=self.mag)


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
