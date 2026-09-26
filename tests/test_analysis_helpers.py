"""Drive an Analyzer deterministically from a SyntheticSource (host time = sample clock)."""

from collections.abc import Iterator

from tidalviz.analysis import AnalysisSettings, Analyzer
from tidalviz.capture.paced import PacedSource
from tidalviz.capture.ring import RingBuffer
from tidalviz.frame import AudioFrame


def frames(
    src: PacedSource, seconds: float, settings: AnalysisSettings | None = None
) -> Iterator[AudioFrame]:
    """Yield the (reused) frame after each hop; host_time is the newest sample's time."""
    settings = settings or AnalysisSettings()
    sr, ch = src.format.sample_rate, src.format.channels
    ring = RingBuffer(capacity=16384, channels=ch)
    an = Analyzer(sr, ch, settings)
    for _ in range(int(seconds * sr / settings.hop)):
        ring.write(src.render(settings.hop), 0.0)
        yield an.process(ring, ring.written / sr)


def test_fast_fft_helpers_match_numpy_fft():
    import numpy as np

    from tidalviz.analysis.fft import irfft, rfft

    x = np.random.default_rng(1).standard_normal(2048)
    spec = np.zeros(1025, dtype=np.complex128)
    rfft(x, spec)
    np.testing.assert_allclose(spec, np.fft.rfft(x), atol=1e-9)
    back = np.zeros(2048, dtype=np.float64)
    irfft(spec, back)
    np.testing.assert_allclose(back, x, atol=1e-9)
