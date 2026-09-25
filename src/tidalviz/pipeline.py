"""Capture → ring → analysis thread → encoded frames (docs/protocols.md §2, Threads).

Two threads:

- **analysis**: sleeps on the ring's condition until a hop of new samples has arrived (driven
  by sample arrival, not a timer), analyzes the newest window, encodes it and calls
  ``publish(bytes)``. If it falls behind it skips straight to the newest hop and counts the
  skipped hops as dropped — frames are never queued.
- **supervisor**: starts/stops sources (a catap start can take seconds), handles
  ``switch_source`` without touching the analysis thread, and restarts a source whose
  ``failed`` event is set (or whose start raised), with exponential backoff and status
  callbacks.

Integration passes ``publish=lambda d: loop.call_soon_threadsafe(hub.publish, d)``.
"""

import ctypes
import logging
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from tidalviz.analysis import AnalysisSettings, Analyzer
from tidalviz.capture.base import AudioSource, SourceFormat
from tidalviz.capture.ring import RingBuffer
from tidalviz.frame import F32
from tidalviz.transport.frame import encode

log = logging.getLogger(__name__)

StatusCallback = Callable[[str, str], None]  # (level "info" | "warn" | "error", plain text)
SilenceCallback = Callable[[bool], None]

RING_SECONDS = 1.0
STATS_WINDOW = 512  # frames (~5.5 s) behind each reported percentile
STABLE_AFTER_S = 10.0  # a source that ran this long before failing starts over at backoff[0]


class _TimeConstraintPolicy(ctypes.Structure):
    _fields_ = (
        ("period", ctypes.c_uint32),
        ("computation", ctypes.c_uint32),
        ("constraint", ctypes.c_uint32),
        ("preemptible", ctypes.c_int),
    )


class _Timebase(ctypes.Structure):
    _fields_ = (("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32))


def promote_to_realtime(period_s: float, computation_s: float) -> bool:
    """Give the calling thread Mach's time-constraint (real-time) policy, as audio threads use.

    A thread that wakes every ~10 ms for ~0.1 ms of work otherwise runs on idle-clocked cores:
    on an M4 Pro on battery the analyzer's p99 went from 1.8 ms to 0.95 ms with this (hot-loop
    cost is ~0.1 ms). The kernel demotes the thread if it overruns, so this is safe to try.
    Returns False where unsupported.
    """
    if sys.platform != "darwin":
        return False
    try:
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        tb = _Timebase()
        libc.mach_timebase_info(ctypes.byref(tb))

        def ticks(seconds: float) -> int:
            return int(seconds * 1e9 * tb.denom / tb.numer)

        policy = _TimeConstraintPolicy(
            ticks(period_s), ticks(computation_s), ticks(period_s / 2), 1
        )
        libc.mach_thread_self.restype = ctypes.c_uint32
        thread_time_constraint_policy, count = 2, 4
        rc = libc.thread_policy_set(
            libc.mach_thread_self(), thread_time_constraint_policy, ctypes.byref(policy), count
        )
    except (OSError, AttributeError):
        return False
    return rc == 0


@dataclass(frozen=True, slots=True)
class PipelineStats:
    analysis_ms_p50: float  # Analyzer.process only (encode counts toward capture→send)
    analysis_ms_p99: float
    capture_to_send_ms_p95: float  # time publish() returned − host time of the newest sample
    dropped_frames: int  # hops skipped because analysis fell behind
    frames: int  # frames published


class _Window:
    """Fixed-size circular window of measurements for percentiles (preallocated)."""

    def __init__(self, n: int) -> None:
        self._buf: F32 = np.zeros(n, dtype=np.float32)
        self._i = 0
        self._count = 0

    def add(self, v: float) -> None:
        self._buf[self._i] = v
        self._i = (self._i + 1) % self._buf.size
        self._count = min(self._count + 1, self._buf.size)

    def percentile(self, q: float) -> float:
        if self._count == 0:
            return 0.0
        return float(np.percentile(self._buf[: self._count], q))


class AudioPipeline:
    def __init__(
        self,
        source: AudioSource,
        publish: Callable[[bytes], None],
        *,
        settings: AnalysisSettings | None = None,
        on_status: StatusCallback | None = None,
        on_silence: SilenceCallback | None = None,
        silence_seconds: float = 4.0,
        backoff: Sequence[float] = (0.5, 1.0, 2.0, 4.0, 8.0),
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings or AnalysisSettings()
        self._publish = publish
        self._on_status = on_status
        self._on_silence = on_silence
        self._silence_seconds = silence_seconds
        self._backoff = tuple(backoff)
        self._clock = clock

        self._desired: AudioSource = source
        self._active: AudioSource | None = None
        self._gen = 0  # bumps on every start/stop so late callbacks of old sources are ignored
        self._wake = threading.Event()  # pokes the supervisor
        self._running = False
        self._paused = False
        self._format: SourceFormat | None = None
        self._ring = RingBuffer(1, 1)
        self._analyzer: Analyzer | None = None
        self._configure(source.format)

        self._analysis_ms = _Window(STATS_WINDOW)
        self._latency_ms = _Window(STATS_WINDOW)
        self._dropped = 0
        self._published = 0
        self._silent_since: float | None = None
        self._silence_reported = False
        self._threads: list[threading.Thread] = []

    # --- public API -------------------------------------------------------------------------

    @property
    def source(self) -> AudioSource:
        """The requested source (it may still be starting or restarting)."""
        return self._desired

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        for target, name in ((self._supervise, "supervisor"), (self._analyze, "analysis")):
            t = threading.Thread(target=target, name=f"tidalviz-{name}", daemon=True)
            self._threads.append(t)
            t.start()

    def stop(self) -> None:
        """Stop both threads and the active source. Blocks until they have finished."""
        self._running = False
        self._wake.set()
        self._ring.wake()
        for t in self._threads:
            t.join(timeout=5.0)
        self._threads.clear()

    def switch_source(self, source: AudioSource) -> None:
        """Replace the source; the analysis thread (and so the renderer) keeps running."""
        self._desired = source
        self._wake.set()

    def pause(self) -> None:
        """Stop analyzing (no renderer connected). Capture keeps filling the ring."""
        self._paused = True

    def resume(self) -> None:
        self._paused = False
        self._ring.wake()

    @property
    def paused(self) -> bool:
        return self._paused

    def stats(self) -> PipelineStats:
        return PipelineStats(
            analysis_ms_p50=self._analysis_ms.percentile(50),
            analysis_ms_p99=self._analysis_ms.percentile(99),
            capture_to_send_ms_p95=self._latency_ms.percentile(95),
            dropped_frames=self._dropped,
            frames=self._published,
        )

    # --- source side (supervisor thread) ----------------------------------------------------

    def _configure(self, fmt: SourceFormat) -> None:
        """A new ring + analyzer when the format changes. Never resamples."""
        if fmt == self._format:
            return
        ring = RingBuffer(max(8192, int(fmt.sample_rate * RING_SECONDS)), fmt.channels)
        analyzer = Analyzer(fmt.sample_rate, fmt.channels, self.settings)
        old = self._ring
        self._analyzer, self._format = analyzer, fmt
        self._ring = ring  # the analysis thread notices the new ring and follows it
        old.wake()

    def _make_ingest(self, gen: int) -> Callable[[F32, float], None]:
        def ingest(samples: F32, t: float) -> None:
            if gen != self._gen:
                return  # a stopped or replaced source's late buffer
            ring = self._ring
            if samples.shape[1] != ring.channels:
                self._wake.set()  # format changed under us; the supervisor restarts
                return
            ring.write(samples, t)

        return ingest

    def _status(self, level: str, text: str) -> None:
        log.log(logging.INFO if level == "info" else logging.WARNING, text)
        if self._on_status is not None:
            self._on_status(level, text)

    def _start(self, source: AudioSource) -> bool:
        self._gen += 1
        self._configure(source.format)
        source.failed.clear()
        try:
            source.start(self._make_ingest(self._gen))
        except Exception as exc:
            log.warning("audio source failed to start: %s", exc)
            return False
        self._configure(source.format)  # catap knows the real format only once started
        return True

    def _stop(self, source: AudioSource | None) -> None:
        self._gen += 1
        if source is None:
            return
        try:
            source.stop()
        except Exception:
            log.exception("audio source failed to stop")

    def _sleep(self, seconds: float, target: AudioSource) -> None:
        """Wait, but return early when stopping or when the source is switched."""
        end = time.monotonic() + seconds
        while self._running and self._desired is target:
            left = end - time.monotonic()
            if left <= 0:
                return
            self._wake.wait(min(left, 0.05))
            self._wake.clear()

    def _retry_later(self, attempt: int, target: AudioSource) -> None:
        delay = self._backoff[min(attempt - 1, len(self._backoff) - 1)]
        self._status("warn", f"Audio capture stopped; retrying in {delay:g} s")
        self._sleep(delay, target)

    def _supervise(self) -> None:
        target: AudioSource | None = None
        attempt = 0  # consecutive failures of target
        started_at = 0.0
        while self._running:
            desired = self._desired
            if desired is not target:
                self._stop(self._active)
                self._active, target, attempt = None, desired, 0
            src = self._active
            if src is None:
                if self._start(desired):
                    self._active, started_at = desired, time.monotonic()
                    if attempt:
                        self._status("info", "Audio capture restarted")
                else:
                    attempt += 1
                    self._retry_later(attempt, desired)
                continue
            if src.failed.is_set():
                if time.monotonic() - started_at > STABLE_AFTER_S:
                    attempt = 0
                attempt += 1
                self._stop(src)
                self._active = None
                self._retry_later(attempt, desired)
                continue
            if src.format != self._format:
                self._stop(src)  # new device format: restart right away on it
                self._active = None
                continue
            self._wake.wait(0.1)
            self._wake.clear()
        self._stop(self._active)
        self._active = None

    # --- analysis thread --------------------------------------------------------------------

    def _analyze(self) -> None:
        hop = self.settings.hop
        promote_to_realtime(hop / (self._format or SourceFormat(48000.0, 2)).sample_rate, 0.001)
        ring = self._ring
        consumed = 0  # every ring is fresh: all its samples are new
        while self._running:
            if self._ring is not ring:  # reconfigured for a new source / format
                ring = self._ring
                consumed = 0
            if not ring.wait_for(consumed + hop, timeout=0.1):
                continue
            written = ring.written
            if self._paused:
                consumed = written
                continue
            hops = (written - consumed) // hop
            if hops > 1:
                self._dropped += hops - 1  # stale: skip straight to the newest hop
            consumed += hops * hop
            analyzer = self._analyzer
            if analyzer is not None and self._ring is ring:
                self._frame(ring, analyzer)

    def _frame(self, ring: RingBuffer, analyzer: Analyzer) -> None:
        t0 = time.perf_counter()
        host_time = ring.newest_time
        frame = analyzer.process(ring, host_time)
        self._analysis_ms.add((time.perf_counter() - t0) * 1000.0)  # the PRD's "analysis cost"
        data = encode(frame)
        self._publish(data)
        self._published += 1
        self._latency_ms.add((self._clock() - host_time) * 1000.0)
        self._track_silence(frame.silent, host_time)

    def _track_silence(self, silent: bool, host_time: float) -> None:
        cb = self._on_silence
        if silent:
            if self._silent_since is None:
                self._silent_since = host_time
            if (
                not self._silence_reported
                and host_time - self._silent_since >= self._silence_seconds
            ):
                self._silence_reported = True
                if cb is not None:
                    cb(True)
        else:
            self._silent_since = None
            if self._silence_reported:
                self._silence_reported = False
                if cb is not None:
                    cb(False)
