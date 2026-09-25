"""System-wide and per-app capture through catap (Core Audio process taps).

catap calls ``on_buffer`` on its own worker thread. We wrap the interleaved float32 bytes in a
zero-copy numpy view and hand it straight to ``on_samples`` (which copies once, into the ring).
Capture failures (sleep/wake, output-device change) set ``failed``; the pipeline restarts us.
``stop()`` is never called from inside ``on_buffer``.

The sample timestamp is ``time.monotonic()`` when the buffer reaches Python, so latency figures
measured from it exclude catap's own queueing (buffers arrive every ~10.7 ms, in order).
"""

import contextlib
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import catap
import numpy as np

from tidalviz.capture.base import OnSamples, SourceFormat

BufferCallback = Callable[[catap.AudioBuffer], None]


@dataclass(frozen=True, slots=True)
class AudioApp:
    id: str  # "app:<pid>", matches the control protocol's SourceInfo id
    name: str
    pid: int


def list_audio_apps() -> list[AudioApp]:
    """Processes currently producing audio (excluding Tidalviz itself)."""
    own = os.getpid()
    return [
        AudioApp(id=f"app:{p.pid}", name=p.name, pid=p.pid)
        for p in catap.list_audio_processes()
        if p.is_outputting and p.pid != own
    ]


class _CatapSource:
    name = "catap"

    def __init__(self) -> None:
        self.failed = threading.Event()
        self._format = SourceFormat(48000.0, 2)  # best guess until catap reports the real one
        self._session: catap.RecordingSession | None = None
        self._on_samples: OnSamples | None = None
        self._stopping = threading.Event()
        self._watcher: threading.Thread | None = None

    @property
    def format(self) -> SourceFormat:
        return self._format

    def _open(self, on_buffer: BufferCallback) -> catap.RecordingSession:
        raise NotImplementedError

    def start(self, on_samples: OnSamples) -> None:
        if self._session is not None:
            raise RuntimeError("already started")
        self.failed.clear()
        self._stopping.clear()
        self._on_samples = on_samples
        session = self._open(self._on_buffer)
        session.start()  # OSError propagates; the pipeline treats it as a failed start
        self._session = session
        fmt = session.stream_format
        if fmt is not None:
            self._format = SourceFormat(fmt.sample_rate, fmt.num_channels)
        self._watcher = threading.Thread(
            target=self._watch, args=(session,), name="tidalviz-catap-watch", daemon=True
        )
        self._watcher.start()

    def stop(self) -> None:
        self._stopping.set()
        self._on_samples = None
        session, self._session = self._session, None
        if session is not None:
            # A failed or torn-down session may refuse to stop; there is nothing more to release.
            with contextlib.suppress(OSError, RuntimeError):
                session.stop()
        watcher, self._watcher = self._watcher, None
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=2.0)

    def _on_buffer(self, buf: catap.AudioBuffer) -> None:
        on_samples = self._on_samples
        if on_samples is None:
            return
        t = time.monotonic()
        fmt = buf.format
        if fmt.sample_rate != self._format.sample_rate or fmt.num_channels != self._format.channels:
            self._format = SourceFormat(fmt.sample_rate, fmt.num_channels)
        if fmt.sample_type != "float" or fmt.bits_per_sample != 32:
            self.failed.set()  # catap delivers float32 on every Mac we support; don't guess
            return
        ch = fmt.num_channels
        x = np.frombuffer(buf.data, dtype="<f4", count=buf.frame_count * ch)
        try:
            on_samples(x.reshape(buf.frame_count, ch), t)
        except Exception:
            self.failed.set()

    def _watch(self, session: catap.RecordingSession) -> None:
        while not self._stopping.is_set():
            try:
                if session.wait_for_capture_failure(0.25):
                    break
            except RuntimeError:  # not recording any more
                break
        if not self._stopping.is_set():
            self.failed.set()


class CatapSystemSource(_CatapSource):
    """All system audio, excluding Tidalviz's own process when it has an audio object."""

    name = "All system audio"

    def _open(self, on_buffer: BufferCallback) -> catap.RecordingSession:
        own = catap.find_process_by_pid(os.getpid())
        exclude = [own] if own is not None else []
        return catap.record_system_audio(exclude=exclude, on_buffer=on_buffer)


class CatapAppSource(_CatapSource):
    """One app's audio (``process`` is a catap AudioProcess or a process name)."""

    def __init__(self, process: catap.AudioProcess | str) -> None:
        super().__init__()
        self.process = process
        self.name = process if isinstance(process, str) else process.name

    def _open(self, on_buffer: BufferCallback) -> catap.RecordingSession:
        return catap.record_process(self.process, on_buffer=on_buffer)
