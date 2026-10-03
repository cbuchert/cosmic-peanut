"""System-wide and per-app capture on Linux through PipeWire's ``pw-record`` (the macOS
counterpart is catap_source.py).

No PipeWire binding ships as a wheel, so we run ``pw-record --raw`` and read float32 from its
stdout; PipeWire resamples and downmixes to the 48 kHz stereo the pipeline expects. System audio
follows the default output's monitor. ``--latency 256`` makes one 512-frame block (the analysis
hop) per write; 512 writes two at once, which the pipeline counts as a dropped hop.

Per-app capture (``app:<pid>``) targets the app's first running playback node. Its pid comes from
``application.process.id`` or, for native and ALSA-plugin clients, PipeWire's ``pipewire.sec.pid``.
A reader thread fills one preallocated buffer per block and hands ``on_samples`` a zero-copy view.
``failed`` is set when pw-record exits, stalls, or the callback raises; the pipeline restarts us
with backoff, and an app that is gone ends in "not playing" until it plays again. ``stop()`` may
be called from inside ``on_samples``.
"""

import io
import json
import logging
import math
import os
import select
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, cast

import numpy as np

from tidalviz.capture.base import OnSamples, SourceFormat

SAMPLE_RATE = 48000
CHANNELS = 2
BLOCK = 512  # frames per on_samples call: the analysis hop
STALL_TIMEOUT_S = 1.0  # a pw-record that writes nothing for this long counts as failed
FIRST_BLOCK_TIMEOUT_S = 4.0  # before the first block a suspended sink may be slow to wake

log = logging.getLogger(__name__)

_NODE = "PipeWire:Interface:Node"
_CLIENT = "PipeWire:Interface:Client"
_OUTPUT_STREAM = "Stream/Output/Audio"

Dump = list[dict[str, Any]]
_warned_no_pw_dump = False


@dataclass(frozen=True, slots=True)
class AudioApp:
    id: str  # "app:<pid>", matches the control protocol's SourceInfo id
    name: str
    pid: int


def record_args(serial: int | None) -> list[str]:
    """``pw-record`` arguments: the default output's monitor, or one stream node's output.

    An app target is pinned with ``node.dont-reconnect``: when that stream ends, WirePlumber would
    otherwise re-link us to the default input, i.e. the microphone.
    """
    if serial is None:
        target = ["-P", "{ stream.capture.sink=true }"]
    elif serial < 1:
        raise ValueError(f"not a PipeWire object serial: {serial}")
    else:
        target = ["--target", str(serial), "-P", "{ node.dont-reconnect=true }"]
    return [
        "--raw",
        *target,
        "--latency",
        str(BLOCK // 2),
        "--rate",
        str(SAMPLE_RATE),
        "--channels",
        str(CHANNELS),
        "--format",
        "f32",
        "-",
    ]


# --- pw-dump: which apps are playing -----------------------------------------------------------


def _dump() -> Dump:
    out = subprocess.run(["pw-dump"], capture_output=True, check=True, timeout=5)
    return json.loads(out.stdout)


def _int(value: Any) -> int | None:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _props(obj: Any) -> dict[str, Any] | None:
    """``obj["info"]["props"]`` of one pw-dump object, or None when it isn't shaped like that."""
    info: Any = cast(Any, obj).get("info") if isinstance(obj, dict) else None
    props = cast(Any, info).get("props") if isinstance(info, dict) else None
    return cast(dict[str, Any], props) if isinstance(props, dict) else None


def _client_props(props: dict[str, Any], clients: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """Properties of the node's client; ``client.id`` is only trusted when it is an int."""
    client_id = props.get("client.id")
    return clients.get(client_id, {}) if isinstance(client_id, int) else {}


def _pid(props: dict[str, Any], cprops: dict[str, Any]) -> int | None:
    """The process behind a stream node, or None when PipeWire can't tell."""
    if (pid := _int(props.get("application.process.id"))) is not None:
        return pid
    if (pid := _int(cprops.get("application.process.id"))) is not None:
        return pid
    if cprops.get("client.api") != "pipewire-pulse":
        return _int(cprops.get("pipewire.sec.pid")) or None  # a PulseAudio client's is the bridge
    return None


def _streams(dump: Dump) -> list[tuple[int, int, str]]:
    """(pid, object serial, name) of every running playback stream whose pid is known.

    pw-dump is a daemon's view of other processes' clients, so one odd object is skipped rather
    than allowed to hide every app.
    """
    objects: list[Any] = (
        dump if isinstance(dump, list) else []  # pyright: ignore[reportUnnecessaryIsInstance]
    )
    clients: dict[int, dict[str, Any]] = {}
    nodes: list[tuple[dict[str, Any], dict[str, Any]]] = []  # (info, props)
    for o in objects:
        props = _props(o)
        if props is None:
            continue
        if o.get("type") == _CLIENT and isinstance(o.get("id"), int):
            clients[o["id"]] = props
        elif o.get("type") == _NODE:
            nodes.append((o["info"], props))
    out: list[tuple[int, int, str]] = []
    for info, props in nodes:
        if info.get("state") != "running" or props.get("media.class") != _OUTPUT_STREAM:
            continue
        cprops = _client_props(props, clients)
        pid = _pid(props, cprops)
        serial = _int(props.get("object.serial"))
        if pid is None or serial is None:
            continue
        name = (
            props.get("application.name")
            or cprops.get("application.name")
            or props.get("node.name", str(pid))
        )
        out.append((pid, serial, name))
    return out


def parse_audio_apps(dump: Dump, own_pid: int) -> list[AudioApp]:
    """Apps with a running playback stream, once per pid (excluding ``own_pid``)."""
    apps: dict[int, AudioApp] = {}
    for pid, _, name in _streams(dump):
        if pid != own_pid:
            apps.setdefault(pid, AudioApp(id=f"app:{pid}", name=name, pid=pid))
    return list(apps.values())


def find_stream_serial(dump: Dump, pid: int) -> int | None:
    """Object serial of the first running playback stream of ``pid``."""
    return next((serial for p, serial, _ in _streams(dump) if p == pid), None)


def list_audio_apps() -> list[AudioApp]:
    """Processes currently producing audio (excluding Tidalviz itself).

    No ``pw-dump`` (a container, a PulseAudio-only system) is an expected state, not an error:
    one warning, then no apps.
    """
    global _warned_no_pw_dump
    try:
        dump = _dump()
    except FileNotFoundError:
        if not _warned_no_pw_dump:
            _warned_no_pw_dump = True
            log.warning("pw-dump not found; per-app capture unavailable")
        return []
    return parse_audio_apps(dump, os.getpid())


# --- sources -----------------------------------------------------------------------------------


class _PipeWireSource:
    name = "pipewire"

    def __init__(
        self,
        *,
        program: str = "pw-record",
        stall_timeout: float = STALL_TIMEOUT_S,
        first_block_timeout: float = FIRST_BLOCK_TIMEOUT_S,
    ):
        self.failed = threading.Event()
        self._program = program
        self._stall_ms = int(stall_timeout * 1000)
        self._first_block_ms = int(first_block_timeout * 1000)
        self._format = SourceFormat(float(SAMPLE_RATE), CHANNELS)
        self._buf = bytearray(BLOCK * CHANNELS * 4)
        self._block = np.frombuffer(self._buf, dtype="<f4").reshape(BLOCK, CHANNELS)
        self._proc: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()

    @property
    def format(self) -> SourceFormat:
        return self._format

    def _serial(self) -> int | None:
        raise NotImplementedError

    def start(self, on_samples: OnSamples) -> None:
        if self._proc is not None:
            raise RuntimeError("already started")
        self.failed.clear()
        self._stopping.clear()
        # OSError (no pw-record) and RuntimeError (app gone) propagate; the pipeline treats
        # them as a failed start.
        proc = subprocess.Popen(
            [self._program, *record_args(self._serial())],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            bufsize=0,
        )
        self._proc = proc
        self._thread = threading.Thread(
            target=self._read, args=(proc, on_samples), name="tidalviz-pipewire", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        proc, self._proc = self._proc, None
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _read(self, proc: subprocess.Popen[bytes], on_samples: OnSamples) -> None:
        stdout = cast(io.RawIOBase, proc.stdout)  # bufsize=0: a raw pipe, so reads can be partial
        view = memoryview(self._buf)
        size = len(self._buf)
        # A pw-record that stays alive but stops writing (its target vanished) never reaches EOF
        # and readinto would block for good, so every read waits at most stall_timeout.
        ready = select.poll()
        ready.register(stdout, select.POLLIN)
        wait_ms = self._first_block_ms
        try:
            while not self._stopping.is_set():
                if not ready.poll(wait_ms):
                    raise TimeoutError("pw-record stopped writing")
                got = stdout.readinto(view)
                while got and got < size:  # a pipe read may end anywhere in the block
                    if not ready.poll(self._stall_ms):
                        raise TimeoutError("pw-record stopped writing mid-block")
                    n = stdout.readinto(view[got:])
                    if not n:
                        got = 0
                        break
                    got += n
                if not got:
                    break  # EOF: pw-record exited
                t = time.monotonic()
                wait_ms = self._stall_ms
                if self._stopping.is_set():
                    return
                on_samples(self._block, t)
        except Exception:
            if not self._stopping.is_set():  # stop() killing a pw-record that ignored SIGTERM
                self.failed.set()
            return
        finally:
            stdout.close()
        if not self._stopping.is_set():
            self.failed.set()


class PipeWireSystemSource(_PipeWireSource):
    """All system audio: the default output device's monitor."""

    name = "All system audio"

    def _serial(self) -> int | None:
        return None


class PipeWireAppSource(_PipeWireSource):
    """One app's audio, through its first running playback stream."""

    def __init__(
        self,
        app: AudioApp,
        *,
        program: str = "pw-record",
        stall_timeout: float = STALL_TIMEOUT_S,
        first_block_timeout: float = FIRST_BLOCK_TIMEOUT_S,
    ) -> None:
        super().__init__(
            program=program, stall_timeout=stall_timeout, first_block_timeout=first_block_timeout
        )
        self.app = app
        self.name = app.name

    def _serial(self) -> int | None:
        serial = find_stream_serial(_dump(), self.app.pid)
        if serial is None:
            raise RuntimeError(f"{self.app.name} (pid {self.app.pid}) is not playing audio")
        return serial
