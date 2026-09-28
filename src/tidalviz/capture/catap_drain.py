"""Pace catap's drain thread: read once per audio chunk instead of polling every 1 ms.

catap 0.6's native recorder fills a ring from the Core Audio IOProc; a Python thread
(``catap-native-audio-drain``) polls it with ``stop_event.wait(0.001)`` between empty reads,
and every read allocates and zeroes a 128 KB buffer. That is ~1,000 wakeups a second for ~94
chunks, ~2.5–3.5% of a core on its own: a third of Tidalviz's whole CPU budget.

Chunks arrive at a steady period (512 frames at 48 kHz: 10.7 ms). ``install()`` wraps catap's
``AudioRecorder._drain_native_recorder``: once two consecutive intervals agree, it sleeps
until ``EARLY_S`` before the next chunk is due and reads; if the chunk isn't there yet it
sleeps until ``LATE_S`` after it is due and reads again. About two reads per chunk, with
~0.5 ms average detection latency (catap's own polling: ~0.5 ms). A chunk that is later than
that falls back to catap's 1 ms polling, and irregular arrivals turn pacing off.
"""

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from tidalviz.capture.realtime import promote_to_realtime

log = logging.getLogger(__name__)


class DrainPacer:
    """Predicts the next chunk from the last two arrival intervals (monotonic seconds)."""

    EARLY_S = 0.001  # first read this long before the chunk is due
    LATE_S = 0.00025  # second read this long after it is due
    AGREE_S = 0.002  # consecutive intervals must agree this closely to be trusted
    MIN_PERIOD_S, MAX_PERIOD_S = 0.002, 0.1

    def __init__(self) -> None:
        self._last: float | None = None  # when the last chunk was read
        self._interval = 0.0  # the interval before it
        self._period = 0.0  # 0 = not trusted, don't pace

    @property
    def pacing(self) -> bool:
        return self._period > 0.0

    def polled(self, drained: bool, now: float) -> None:
        """Record a read of catap's ring at ``now`` (``drained``: it returned audio)."""
        if not drained:
            return
        if self._last is not None:
            interval = now - self._last
            agree = abs(interval - self._interval) <= self.AGREE_S
            ok = self.MIN_PERIOD_S <= interval <= self.MAX_PERIOD_S
            # The shorter one: detection lags arrival by 0–(EARLY + LATE), never leads it.
            self._period = min(interval, self._interval) if agree and ok else 0.0
            self._interval = interval
        self._last = now

    def idle_wait(self, now: float) -> float:
        """Seconds to sleep before the next read (until ``EARLY_S`` before the chunk is due)."""
        if not self._period or self._last is None:
            return 0.0
        return max(0.0, self._last + self._period - self.EARLY_S - now)

    def late_wait(self, now: float) -> float:
        """After an early, empty read: seconds until ``LATE_S`` after the chunk is due."""
        if not self._period or self._last is None:
            return 0.0
        return max(0.0, self._last + self._period + self.LATE_S - now)


def _promote() -> None:
    promote_to_realtime(0.005, 0.0005)


def install(recorder_cls: Any, promote: Callable[[], object] = _promote) -> bool:
    """Wrap ``recorder_cls._drain_native_recorder`` (catap's AudioRecorder). Idempotent.

    The drain thread is promoted (once) to real-time scheduling: at default QoS a timed wait
    overshoots by 2–5 ms (timer coalescing), so a paced sleep would land after the next chunk
    and the reader would get two at once. Returns False (and leaves catap alone) if this catap
    version has no such method.
    """
    orig: Callable[..., bool] | None = getattr(recorder_cls, "_drain_native_recorder", None)
    if orig is None:
        log.warning("catap has no _drain_native_recorder; drain thread stays at 1 ms polling")
        return False
    if getattr(orig, "_tidalviz_paced", False):
        return True

    def paced(self: Any, native_recorder: Any, abort_event: threading.Event) -> bool:
        state = self.__dict__
        pacer: DrainPacer | None = state.get("_tidalviz_pacer")
        if pacer is None:
            pacer = state["_tidalviz_pacer"] = DrainPacer()
        if state.get("_tidalviz_thread") != threading.get_ident():
            state["_tidalviz_thread"] = threading.get_ident()
            promote()
        early = pacer.pacing
        wait = pacer.idle_wait(time.monotonic())
        if wait > 0.0 and abort_event.wait(wait):
            return False
        drained = orig(self, native_recorder, abort_event)
        if not drained and early:
            early = False
            wait = pacer.late_wait(time.monotonic())
            if wait > 0.0 and not abort_event.wait(wait):
                drained = orig(self, native_recorder, abort_event)
        pacer.polled(drained, time.monotonic())
        return drained

    paced._tidalviz_paced = True  # pyright: ignore[reportFunctionMemberAccess]
    paced._tidalviz_orig = orig  # pyright: ignore[reportFunctionMemberAccess]
    recorder_cls._drain_native_recorder = paced
    return True
