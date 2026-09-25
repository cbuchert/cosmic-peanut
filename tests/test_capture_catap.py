import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pytest

from tidalviz.capture import catap_source
from tidalviz.capture.catap_source import CatapSystemSource


@dataclass
class Fmt:
    sample_rate: float = 48000.0
    num_channels: int = 2
    bits_per_sample: int = 32
    sample_type: str = "float"


@dataclass
class Buf:
    data: bytes
    frame_count: int
    format: Fmt = field(default_factory=Fmt)
    input_sample_time: float | None = None


class FakeSession:
    def __init__(self, on_buffer: Any) -> None:
        self.on_buffer = on_buffer
        self.started = False
        self.stopped = False
        self.fail = threading.Event()
        self.stream_format: Fmt | None = Fmt()

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def wait_for_capture_failure(self, timeout: float | None = None) -> bool:
        return self.fail.wait(timeout)


@dataclass
class Proc:
    pid: int
    name: str
    is_outputting: bool = True
    audio_object_id: int = 1
    bundle_id: str | None = None


class FakeCatap:
    def __init__(self, own: Proc | None = None, procs: list[Proc] | None = None) -> None:
        self.own = own
        self.procs = procs or []
        self.sessions: list[FakeSession] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def find_process_by_pid(self, pid: int) -> Proc | None:
        return self.own if pid == os.getpid() else None

    def list_audio_processes(self) -> list[Proc]:
        return self.procs

    def record_system_audio(self, output_path: Any = None, **kw: Any) -> FakeSession:
        self.calls.append(("system", kw))
        s = FakeSession(kw["on_buffer"])
        self.sessions.append(s)
        return s

    def record_process(self, process: Any, output_path: Any = None, **kw: Any) -> FakeSession:
        self.calls.append(("process", {"process": process, **kw}))
        s = FakeSession(kw["on_buffer"])
        self.sessions.append(s)
        return s


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeCatap:
    f = FakeCatap(own=Proc(pid=os.getpid(), name="python"))
    monkeypatch.setattr(catap_source, "catap", f)
    return f


def test_system_source_delivers_interleaved_float32_as_frames(fake: FakeCatap):
    got: list[tuple[np.ndarray, float]] = []
    src = CatapSystemSource()
    src.start(lambda x, t: got.append((x.copy(), t)))
    session = fake.sessions[0]
    assert session.started
    pcm = np.arange(8, dtype="<f4")  # 4 frames × 2 channels, interleaved
    before = time.monotonic()
    session.on_buffer(Buf(pcm.tobytes(), 4))
    x, t = got[0]
    np.testing.assert_array_equal(x, pcm.reshape(4, 2))
    assert before <= t <= time.monotonic()
    src.stop()
    assert session.stopped


def test_system_source_excludes_its_own_process(fake: FakeCatap):
    src = CatapSystemSource()
    src.start(lambda x, t: None)
    assert fake.calls[0][1]["exclude"] == [fake.own]
    src.stop()


def test_system_source_tolerates_own_process_not_found(fake: FakeCatap):
    fake.own = None
    src = CatapSystemSource()
    src.start(lambda x, t: None)
    assert list(fake.calls[0][1]["exclude"]) == []
    src.stop()


def test_format_comes_from_the_session_once_started(fake: FakeCatap):
    src = CatapSystemSource()
    real_record = fake.record_system_audio

    def record(output_path: Any = None, **kw: Any) -> FakeSession:
        s = real_record(output_path, **kw)
        s.stream_format = Fmt(sample_rate=44100.0, num_channels=1)
        return s

    fake.record_system_audio = record  # type: ignore[method-assign]
    src.start(lambda x, t: None)
    assert (src.format.sample_rate, src.format.channels) == (44100.0, 1)
    src.stop()


def test_capture_failure_sets_failed(fake: FakeCatap):
    src = CatapSystemSource()
    src.start(lambda x, t: None)
    assert not src.failed.is_set()
    fake.sessions[0].fail.set()
    assert src.failed.wait(1.0)
    src.stop()


def test_stop_does_not_report_failure(fake: FakeCatap):
    src = CatapSystemSource()
    src.start(lambda x, t: None)
    src.stop()
    time.sleep(0.01)
    assert not src.failed.is_set()


def test_app_source_records_the_given_process(fake: FakeCatap):
    from tidalviz.capture.catap_source import CatapAppSource

    tidal = Proc(pid=4242, name="TIDAL")
    src = CatapAppSource(tidal)  # type: ignore[arg-type]
    assert src.name == "TIDAL"
    src.start(lambda x, t: None)
    assert fake.calls[0][0] == "process" and fake.calls[0][1]["process"] is tidal
    src.stop()


def test_list_audio_apps_returns_outputting_processes_except_ours(fake: FakeCatap):
    from tidalviz.capture.catap_source import AudioApp, list_audio_apps

    fake.procs = [
        Proc(pid=10, name="TIDAL"),
        Proc(pid=11, name="Mail", is_outputting=False),
        Proc(pid=os.getpid(), name="python"),
    ]
    assert list_audio_apps() == [AudioApp(id="app:10", name="TIDAL", pid=10)]
