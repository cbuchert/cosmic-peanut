"""Base for sources that generate PCM themselves (file, synthetic).

``render(n)`` is the deterministic, non-threaded API used by tests and benchmarks. ``start``
runs a thread that emits 512-frame blocks paced by the monotonic clock (or as fast as possible
when ``realtime`` is false).
"""

import threading
import time

import numpy as np
from numpy.typing import NDArray

from tidalviz.capture.base import OnSamples, SourceFormat
from tidalviz.frame import F32

BLOCK = 512


class PacedSource:
    name: str = "paced"

    def __init__(self, sample_rate: float, channels: int, *, realtime: bool = True) -> None:
        self.failed = threading.Event()
        self.realtime = realtime
        self.position = 0  # next sample index render() will produce
        self._format = SourceFormat(sample_rate, channels)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def format(self) -> SourceFormat:
        return self._format

    def _generate(self, i: NDArray[np.int64]) -> F32:
        raise NotImplementedError

    def render(self, n: int) -> F32:
        """The next ``n`` frames, shape (n, channels) float32."""
        i = np.arange(self.position, self.position + n, dtype=np.int64)
        self.position += n
        return self._generate(i)

    def start(self, on_samples: OnSamples) -> None:
        if self._thread is not None:
            raise RuntimeError("already started")
        self._stop.clear()
        self.failed.clear()
        self._thread = threading.Thread(
            target=self._run, args=(on_samples,), name=f"tidalviz-{self.name}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _run(self, on_samples: OnSamples) -> None:
        sr = self._format.sample_rate
        t0 = time.monotonic()
        emitted = 0
        try:
            while not self._stop.is_set():
                emitted += BLOCK
                if self.realtime:
                    delay = t0 + emitted / sr - time.monotonic()
                    if delay > 0 and self._stop.wait(delay):
                        break
                # Render only when due: rendering ahead would compete for the GIL with the
                # analysis thread, which wakes as soon as the previous block lands.
                on_samples(self.render(BLOCK), time.monotonic())
        except Exception:
            self.failed.set()
            raise
