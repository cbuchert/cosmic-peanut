import threading
import time
from collections.abc import Callable

import numpy as np
import pytest

from tidalviz.capture.base import OnSamples, SourceFormat
from tidalviz.pipeline import AudioPipeline
from tidalviz.transport.frame import decode

HOP = 512
SR = 48000.0


class FakeSource:
    """A source the test drives by hand: push() delivers one block through on_samples."""

    def __init__(self, channels: int = 2, fail_starts: int = 0) -> None:
        self.failed = threading.Event()
        self._format = SourceFormat(SR, channels)
        self.on_samples: OnSamples | None = None
        self.starts: list[float] = []
        self.stops = 0
        self.fail_starts = fail_starts
        self.t = 100.0  # host time of the newest pushed sample

    @property
    def format(self) -> SourceFormat:
        return self._format

    def start(self, on_samples: OnSamples) -> None:
        self.starts.append(time.monotonic())
        if len(self.starts) <= self.fail_starts:
            raise OSError("device busy")
        self.on_samples = on_samples

    def stop(self) -> None:
        self.stops += 1
        self.on_samples = None

    def push(self, value: float = 0.1, n: int = HOP) -> None:
        cb = self.on_samples
        assert cb is not None
        self.t += n / SR
        cb(np.full((n, self._format.channels), value, dtype=np.float32), self.t)


class Collector:
    def __init__(self) -> None:
        self.frames: list[bytes] = []
        self.cond = threading.Condition()
        self.gate: threading.Event | None = None

    def __call__(self, data: bytes) -> None:
        if self.gate is not None:
            self.gate.wait(2.0)
        with self.cond:
            self.frames.append(data)
            self.cond.notify_all()

    def wait(self, n: int, timeout: float = 2.0) -> bool:
        with self.cond:
            return self.cond.wait_for(lambda: len(self.frames) >= n, timeout)


def wait_until(pred: Callable[[], bool], timeout: float = 2.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.002)
    return pred()


@pytest.fixture
def running():
    pipes: list[AudioPipeline] = []

    def make(src: FakeSource, out: Collector, **kw: object) -> AudioPipeline:
        p = AudioPipeline(src, out, **kw)  # type: ignore[arg-type]
        pipes.append(p)
        p.start()
        assert wait_until(lambda: src.on_samples is not None)
        return p

    yield make
    for p in pipes:
        p.stop()


def test_publishes_one_encoded_frame_per_hop_of_arriving_samples(running):
    src, out = FakeSource(), Collector()
    running(src, out)
    for i in range(3):
        src.push()
        assert out.wait(i + 1)
    frames = [decode(d) for d in out.frames]
    assert [f.index for f in frames] == [0, 1, 2]
    assert frames[-1].host_time == pytest.approx(src.t)
    assert frames[-1].sample_rate == SR and frames[-1].stereo


def test_a_partial_hop_does_not_produce_a_frame(running):
    src, out = FakeSource(), Collector()
    running(src, out)
    src.push(n=300)
    assert not out.wait(1, timeout=0.2)
    src.push(n=300)  # 600 samples ≥ one hop
    assert out.wait(1)


def test_falling_behind_skips_to_the_newest_hop_and_counts_drops(running):
    src, out = FakeSource(), Collector()
    pipe = running(src, out)
    out.gate = threading.Event()  # the next publish blocks, as if the consumer were slow
    src.push()
    assert wait_until(lambda: pipe.stats().frames == 0 and src.on_samples is not None)
    time.sleep(0.02)  # the analysis thread is now stuck in publish
    for _ in range(5):
        src.push()
    newest = src.t
    out.gate.set()
    assert out.wait(2)
    time.sleep(0.05)
    assert len(out.frames) == 2  # no queue of stale frames
    assert decode(out.frames[1]).host_time == pytest.approx(newest)
    assert pipe.stats().dropped_frames == 4


def test_a_failed_source_is_restarted_with_backoff_and_status(running):
    statuses: list[tuple[str, str]] = []
    src, out = FakeSource(), Collector()
    running(src, out, backoff=(0.02, 0.05), on_status=lambda lvl, t: statuses.append((lvl, t)))
    src.failed.set()
    assert wait_until(lambda: len(src.starts) == 2)
    assert src.stops >= 1
    assert not src.failed.is_set()  # cleared for the new attempt
    assert wait_until(lambda: ("info", "Audio capture restarted") in statuses)
    assert statuses[0][0] == "warn" and "retrying in 0.02 s" in statuses[0][1]
    src.push()
    assert out.wait(1)  # frames flow again from the restarted source


def test_failing_starts_back_off_exponentially(running):
    statuses: list[tuple[str, str]] = []
    src, out = FakeSource(fail_starts=3), Collector()
    running(
        src, out, backoff=(0.02, 0.06, 0.12), on_status=lambda lvl, t: statuses.append((lvl, t))
    )
    assert len(src.starts) == 4
    gaps = np.diff(src.starts)
    assert gaps[0] >= 0.02 and gaps[1] >= 0.06 and gaps[2] >= 0.12
    assert gaps[2] > gaps[1] > gaps[0]
    assert [s for lvl, s in statuses if lvl == "warn"][-1].endswith("0.12 s")


def test_switch_source_keeps_the_analysis_thread_and_ignores_the_old_source(running):
    old, new, out = FakeSource(), FakeSource(channels=1), Collector()
    pipe = running(old, out)
    old.push()
    assert out.wait(1)
    analysis = [t for t in threading.enumerate() if t.name == "tidalviz-analysis"]
    stale_cb = old.on_samples
    pipe.switch_source(new)
    assert wait_until(lambda: new.on_samples is not None)
    assert old.stops == 1 and pipe.source is new
    assert stale_cb is not None
    stale_cb(np.ones((HOP, 2), np.float32), 999.0)  # a late buffer from the old source
    new.push()
    assert out.wait(2)
    f = decode(out.frames[-1])
    assert not f.stereo and f.host_time == pytest.approx(new.t)
    assert [t for t in threading.enumerate() if t.name == "tidalviz-analysis"] == analysis


def test_pause_stops_frames_and_resume_restarts_them(running):
    src, out = FakeSource(), Collector()
    pipe = running(src, out)
    pipe.pause()
    src.push()
    assert not out.wait(1, timeout=0.15)
    pipe.resume()
    src.push()
    assert out.wait(1)
    assert decode(out.frames[0]).host_time == pytest.approx(src.t)


def test_reports_silence_after_4_seconds_and_its_end(running):
    events: list[bool] = []
    src, out = FakeSource(), Collector()
    running(src, out, on_silence=events.append)
    n = 0
    for _ in range(int(4.2 * SR / HOP)):  # 4.2 s of zeros (host time from the source clock)
        src.push(0.0)
        n += 1
        assert out.wait(n)
    assert events == [True]
    src.push(0.2)
    assert out.wait(n + 1)
    assert wait_until(lambda: events == [True, False])


def test_stats_report_analysis_time_and_capture_to_send_latency(running):
    now = [0.0]
    src, out = FakeSource(), Collector()
    pipe = running(src, out, clock=lambda: now[0])
    for i in range(5):
        now[0] = src.t + HOP / SR + 0.003  # publish happens 3 ms after the newest sample
        src.push()
        assert out.wait(i + 1)
    s = pipe.stats()
    assert s.frames == 5 and s.dropped_frames == 0
    assert s.capture_to_send_ms_p95 == pytest.approx(3.0, abs=0.01)
    assert 0.0 < s.analysis_ms_p50 < 5.0


def test_a_source_whose_format_changes_is_restarted_on_the_new_format(running):
    src, out = FakeSource(channels=2), Collector()
    running(src, out)
    src.push()
    assert out.wait(1)
    src._format = SourceFormat(44100.0, 1)  # e.g. the output device switched to mono 44.1 kHz
    assert wait_until(lambda: len(src.starts) == 2)
    assert wait_until(lambda: src.on_samples is not None)
    src.push()
    assert out.wait(2)
    f = decode(out.frames[-1])
    assert not f.stereo and f.sample_rate == 44100.0


def test_realtime_synthetic_source_end_to_end():
    from tidalviz.capture.synthetic import SyntheticSource

    out = Collector()
    pipe = AudioPipeline(SyntheticSource("click120"), out)
    pipe.start()
    try:
        time.sleep(1.0)
    finally:
        pipe.stop()
    frames = [decode(d) for d in out.frames]
    assert 80 <= len(frames) <= 100  # 93.75 frames/s
    assert any(f.onset for f in frames)
    s = pipe.stats()
    assert s.capture_to_send_ms_p95 < 15.0
    assert not any(t.name.startswith("tidalviz-") for t in threading.enumerate())
