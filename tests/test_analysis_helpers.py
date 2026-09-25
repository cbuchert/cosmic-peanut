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
