"""PipeWire capture (Linux). The source reads raw float32 from a ``pw-record`` subprocess.

These tests run the real source against a stand-in ``pw-record`` (a small script writing known
blocks into a real pipe), so threads, pipe reads and process teardown are all real; only the
PipeWire daemon is replaced. ``-m live`` tests (tests/test_live_audio.py) use the real thing.
"""

import json
import stat
import sys
import threading
import time
import tracemalloc
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="PipeWire capture is Linux-only")

if sys.platform == "linux":
    from tidalviz.capture.pipewire_source import (
        FIRST_BLOCK_TIMEOUT_S,
        STALL_TIMEOUT_S,
        AudioApp,
        PipeWireAppSource,
        PipeWireSystemSource,
        find_stream_serial,
        list_audio_apps,
        parse_audio_apps,
        record_args,
    )

FAKE = f"""#!{sys.executable}
import json, os, signal, sys, time
import numpy as np

with open(os.environ["FAKE_PW_ARGV"], "w") as f:
    json.dump(sys.argv[1:], f)
blocks = int(os.environ.get("FAKE_PW_BLOCKS", "0"))  # 0 = until killed
stall = os.environ.get("FAKE_PW_STALL")  # "blocks" or "mid": stay alive but stop writing
chunk = int(os.environ.get("FAKE_PW_CHUNK", "4096"))
out = sys.stdout.buffer
ignore_term = os.environ.get("FAKE_PW_IGNORE_TERM")  # trap SIGTERM, go quiet, keep running
if ignore_term:
    signal.signal(signal.SIGTERM, lambda *_: time.sleep(60))
time.sleep(float(os.environ.get("FAKE_PW_START_DELAY", "0")))  # a sink that is slow to wake
i = 0
while blocks == 0 or i < blocks:
    if stall and i == 2:
        if stall == "mid":
            out.write(bytes(100))  # a partial block, then silence
            out.flush()
        time.sleep(60)
    data = (np.arange(1024) + i * 1024).astype("<f4").tobytes()  # 512 frames x 2 channels
    for k in range(0, len(data), chunk):
        out.write(data[k : k + chunk])
        out.flush()
    i += 1
    time.sleep(0.002)
sys.exit(int(os.environ.get("FAKE_PW_EXIT", "0")))
"""


@pytest.fixture
def fake_pw(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    script = tmp_path / "pw-record"
    script.write_text(FAKE)
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("FAKE_PW_ARGV", str(tmp_path / "argv.json"))
    return str(script)


def argv_of(tmp_path: Path) -> list[str]:
    return json.loads((tmp_path / "argv.json").read_text())


def collect(n: int) -> tuple[list[tuple[Any, float]], threading.Event, Any]:
    got: list[tuple[Any, float]] = []
    enough = threading.Event()

    def on_samples(x: Any, t: float) -> None:
        got.append((x.copy(), t))
        if len(got) == n:
            enough.set()

    return got, enough, on_samples


def test_record_args_for_the_system_follow_the_default_output_monitor():
    assert record_args(None) == [
        "--raw",
        "-P",
        "{ stream.capture.sink=true }",
        "--latency",
        "256",
        "--rate",
        "48000",
        "--channels",
        "2",
        "--format",
        "f32",
        "-",
    ]


def test_record_args_for_an_app_target_its_stream_node():
    args = record_args(1306)
    assert args[:3] == ["--raw", "--target", "1306"]
    assert "stream.capture.sink=true" not in " ".join(args)
    assert args[-1] == "-"


def test_record_args_for_an_app_never_fall_back_to_the_default_input():
    # Without dont-reconnect, WirePlumber re-links pw-record to the microphone when the stream ends.
    args = record_args(1306)
    assert args[args.index("-P") + 1] == "{ node.dont-reconnect=true }"
    assert "dont-reconnect" not in " ".join(record_args(None))  # the monitor path doesn't need it


@pytest.mark.parametrize("serial", [0, -1])
def test_record_args_refuse_a_target_that_is_not_a_node_serial(serial: int):
    with pytest.raises(ValueError, match="serial"):
        record_args(serial)


def test_system_source_delivers_512_frame_float32_blocks_exactly(fake_pw: str):
    got, enough, on_samples = collect(3)
    src = PipeWireSystemSource(program=fake_pw)
    assert (src.format.sample_rate, src.format.channels) == (48000.0, 2)
    before = time.monotonic()
    src.start(on_samples)
    assert enough.wait(5.0)
    src.stop()
    for i, (x, t) in enumerate(got[:3]):
        assert x.shape == (512, 2) and x.dtype == np.float32
        np.testing.assert_array_equal(x.ravel(), np.arange(1024) + i * 1024)  # interleaved L,R
        assert before <= t <= time.monotonic()
    times = [t for _, t in got]
    assert times == sorted(times)


def test_blocks_stay_aligned_when_the_pipe_delivers_odd_sized_chunks(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("FAKE_PW_CHUNK", "1000")  # not a multiple of 4: splits mid-sample
    got, enough, on_samples = collect(4)
    src = PipeWireSystemSource(program=fake_pw)
    src.start(on_samples)
    assert enough.wait(5.0)
    src.stop()
    for i, (x, _) in enumerate(got[:4]):
        np.testing.assert_array_equal(x.ravel(), np.arange(1024) + i * 1024)


def test_the_source_runs_the_program_with_the_system_arguments(fake_pw: str, tmp_path: Path):
    _, enough, on_samples = collect(1)
    src = PipeWireSystemSource(program=fake_pw)
    src.start(on_samples)
    assert enough.wait(5.0)
    src.stop()
    assert argv_of(tmp_path) == record_args(None)


def test_stop_ends_the_process_and_is_not_a_failure(fake_pw: str):
    got, enough, on_samples = collect(1)
    src = PipeWireSystemSource(program=fake_pw)
    src.start(on_samples)
    assert enough.wait(5.0)
    proc = src._proc  # pyright: ignore[reportPrivateUsage]
    assert proc is not None
    src.stop()
    assert proc.poll() is not None
    time.sleep(0.05)
    assert not src.failed.is_set()
    n = len(got)
    time.sleep(0.05)
    assert len(got) == n  # nothing delivered after stop()


def test_stop_is_not_a_failure_when_pw_record_ignores_sigterm(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch
):
    # stop() waits up to 2 s for the exit before kill(); the reader's stall timeout fires first
    monkeypatch.setenv("FAKE_PW_IGNORE_TERM", "1")
    _, enough, on_samples = collect(1)
    src = PipeWireSystemSource(program=fake_pw, stall_timeout=0.3)
    src.start(on_samples)
    assert enough.wait(5.0)
    src.stop()
    time.sleep(0.05)
    assert not src.failed.is_set()


def test_the_process_dying_sets_failed(fake_pw: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FAKE_PW_BLOCKS", "3")
    monkeypatch.setenv("FAKE_PW_EXIT", "1")
    got, _, on_samples = collect(99)
    src = PipeWireSystemSource(program=fake_pw)
    src.start(on_samples)
    assert src.failed.wait(5.0)
    assert len(got) == 3  # every complete block before the death was delivered
    src.stop()


def test_a_callback_error_sets_failed(fake_pw: str):
    def boom(x: Any, t: float) -> None:
        raise ValueError("ring rejected the block")

    src = PipeWireSystemSource(program=fake_pw)
    src.start(boom)
    assert src.failed.wait(5.0)
    src.stop()


def test_stop_from_inside_the_callback_does_not_deadlock(fake_pw: str):
    src = PipeWireSystemSource(program=fake_pw)
    done = threading.Event()

    def on_samples(x: Any, t: float) -> None:
        src.stop()
        done.set()

    src.start(on_samples)
    assert done.wait(5.0)


def test_start_twice_is_refused_and_a_missing_program_raises_oserror(fake_pw: str, tmp_path: Path):
    src = PipeWireSystemSource(program=fake_pw)
    src.start(lambda x, t: None)
    with pytest.raises(RuntimeError, match="already started"):
        src.start(lambda x, t: None)
    src.stop()
    with pytest.raises(OSError):
        PipeWireSystemSource(program=str(tmp_path / "no-such-pw-record")).start(lambda x, t: None)


def test_restart_after_failure_starts_a_fresh_process(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("FAKE_PW_BLOCKS", "1")
    src = PipeWireSystemSource(program=fake_pw)
    src.start(lambda x, t: None)
    assert src.failed.wait(5.0)
    src.stop()
    monkeypatch.setenv("FAKE_PW_BLOCKS", "0")
    _, enough, on_samples = collect(2)
    src.start(on_samples)  # the pipeline's restart: stop(), then start() again
    assert enough.wait(5.0)
    assert not src.failed.is_set()
    src.stop()


@pytest.mark.parametrize("stall", ["blocks", "mid"])
def test_a_pw_record_that_stays_alive_but_stops_writing_sets_failed(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch, stall: str
):
    monkeypatch.setenv("FAKE_PW_STALL", stall)
    got, _, on_samples = collect(99)
    src = PipeWireSystemSource(program=fake_pw, stall_timeout=0.3)
    start = time.monotonic()
    src.start(on_samples)
    assert src.failed.wait(5.0)
    assert 0.2 < time.monotonic() - start < 3.0
    assert len(got) == 2  # a half-written block is never delivered
    src.stop()  # kills the still-running process
    assert src._proc is None  # pyright: ignore[reportPrivateUsage]


def test_the_first_block_gets_a_longer_deadline_than_a_stall_mid_stream(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("FAKE_PW_START_DELAY", "0.8")  # past stall_timeout, within the first block's
    _, enough, on_samples = collect(5)
    src = PipeWireSystemSource(program=fake_pw, stall_timeout=0.3, first_block_timeout=3.0)
    src.start(on_samples)
    assert enough.wait(5.0)
    assert not src.failed.is_set()
    src.stop()


def test_a_pw_record_that_never_writes_a_first_block_fails_after_the_first_block_deadline(
    fake_pw: str, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("FAKE_PW_START_DELAY", "60")
    src = PipeWireSystemSource(program=fake_pw, stall_timeout=0.3, first_block_timeout=1.2)
    start = time.monotonic()
    src.start(lambda x, t: None)
    assert src.failed.wait(5.0)
    assert 1.0 < time.monotonic() - start < 3.0
    src.stop()


def test_the_default_first_block_deadline_is_longer_than_the_stall_timeout():
    assert FIRST_BLOCK_TIMEOUT_S >= 3.0
    assert FIRST_BLOCK_TIMEOUT_S > STALL_TIMEOUT_S == 1.0


def test_the_read_loop_allocates_nothing_per_block(fake_pw: str):
    count = 0
    enough = threading.Event()

    def on_samples(x: Any, t: float) -> None:
        nonlocal count
        count += 1
        if count == 2000:
            enough.set()

    src = PipeWireSystemSource(program=fake_pw)
    src.start(on_samples)
    deadline = time.monotonic() + 10
    while count < 200 and time.monotonic() < deadline:
        time.sleep(0.01)  # warm up: first blocks, interpreter caches
    tracemalloc.start()
    base, _ = tracemalloc.get_traced_memory()
    tracemalloc.reset_peak()
    start_count = count
    assert enough.wait(30.0)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    src.stop()
    blocks = count - start_count
    assert blocks > 1000
    # Every block is 4 KiB: a per-block copy (even a freed one) would lift the peak by that much.
    assert peak - base < 2048, f"peak {peak - base} bytes over {blocks} blocks"


# --- listing and targeting apps: pw-dump JSON ----------------------------------------------

NODE = "PipeWire:Interface:Node"
CLIENT = "PipeWire:Interface:Client"


def node(
    id: int,
    serial: int,
    name: str,
    *,
    state: str = "running",
    cls: str = "Stream/Output/Audio",
    client: int | None = None,
    pid: Any = None,
    client_id: Any = None,
) -> dict[str, Any]:
    props: dict[str, Any] = {"media.class": cls, "object.serial": serial, "node.name": name}
    if client is not None:
        props["client.id"] = client
    if client_id is not None:
        props["client.id"] = client_id  # any JSON value, as a daemon's view may hold odd ones
    if pid is not None:
        props["application.process.id"] = pid
    return {"id": id, "type": NODE, "info": {"state": state, "props": props}}


def client(id: int, **props: Any) -> dict[str, Any]:
    return {"id": id, "type": CLIENT, "info": {"props": props}}


DUMP: list[dict[str, Any]] = [
    # a native PipeWire player: the daemon knows its pid from the socket credentials
    client(138, **{"application.name": "pw-cat", "pipewire.sec.pid": 4001}),
    node(182, 1276, "pw-play", client=138),
    # a PulseAudio-protocol client (Firefox): its pid is a client property, sec.pid is the bridge
    client(
        98,
        **{
            "application.name": "Firefox",
            "client.api": "pipewire-pulse",
            "application.process.id": 2016,
            "pipewire.sec.pid": 6145,
        },
    ),
    node(190, 1300, "Firefox", client=98),
    node(191, 1301, "Firefox", client=98),  # a second stream of the same app
    # a stream that exposes the pid on the node itself (as a string, as some clients do)
    node(200, 1310, "Chromium", pid="3003"),
    # not outputting, wrong class, our own process
    node(210, 1320, "idle player", state="idle", pid=5005),
    node(211, 1321, "mic", cls="Stream/Input/Audio", pid=5006),
    node(212, 1322, "tidalviz", pid=9999),
    # a stream with no resolvable pid
    node(220, 1330, "mystery"),
    {"id": 5, "type": "PipeWire:Interface:Port", "info": {"props": {}}},
]


def test_parse_audio_apps_lists_running_output_streams_with_a_pid_once_per_app():
    apps = parse_audio_apps(DUMP, own_pid=9999)
    assert apps == [
        AudioApp(id="app:4001", name="pw-cat", pid=4001),
        AudioApp(id="app:2016", name="Firefox", pid=2016),
        AudioApp(id="app:3003", name="Chromium", pid=3003),
    ]


def test_find_stream_serial_picks_the_first_running_stream_of_the_pid():
    assert find_stream_serial(DUMP, 2016) == 1300
    assert find_stream_serial(DUMP, 3003) == 1310
    assert find_stream_serial(DUMP, 4001) == 1276
    assert find_stream_serial(DUMP, 5005) is None  # idle
    assert find_stream_serial(DUMP, 12345) is None


def test_app_source_refuses_to_start_when_the_app_has_no_running_stream(
    fake_pw: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import tidalviz.capture.pipewire_source as ps

    monkeypatch.setattr(ps, "_dump", lambda: DUMP)
    src = PipeWireAppSource(AudioApp(id="app:12345", name="gone", pid=12345), program=fake_pw)
    assert src.name == "gone"
    with pytest.raises(RuntimeError, match="not playing"):
        src.start(lambda x, t: None)
    assert not (tmp_path / "argv.json").exists()  # pw-record was never run, so never defaulted


def test_app_source_records_its_resolved_stream_node(
    fake_pw: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import tidalviz.capture.pipewire_source as ps

    monkeypatch.setattr(ps, "_dump", lambda: DUMP)
    _, enough, on_samples = collect(1)
    src = PipeWireAppSource(AudioApp(id="app:2016", name="Firefox", pid=2016), program=fake_pw)
    src.start(on_samples)
    assert enough.wait(5.0)
    src.stop()
    assert argv_of(tmp_path) == record_args(1300)


@pytest.mark.parametrize(
    "bad",
    [
        {"id": 300, "type": NODE, "info": None},  # info: null
        {"id": 301, "type": NODE},  # no info at all
        node(302, 1340, "bad pid", pid="not-a-number"),
        node(308, 1342, "unhashable client", client_id=[1]),
        node(309, 1343, "unhashable client, no pid", client_id={"a": 1}),
        node(310, 1344, "infinite pid", pid=float("inf")),
        node(311, 1345, "infinite pid, unhashable client", pid=float("inf"), client_id=[1]),
        node(303, 1341, "no serial", pid=7007) | {"info": {"state": "running", "props": None}},
        {"id": 304, "info": {"props": {}}},  # no type
        client(305),  # a client without info props is fine...
        {"id": 306, "type": CLIENT},  # ...and one without info at all
        "not even an object",
    ],
)
def test_one_malformed_object_does_not_abort_the_listing(bad: Any):
    dump = [*DUMP, bad]
    assert parse_audio_apps(dump, own_pid=9999) == parse_audio_apps(DUMP, own_pid=9999)
    assert find_stream_serial(dump, 2016) == 1300


def test_a_node_pid_is_used_even_when_its_client_id_is_not_a_number():
    odd = node(312, 1346, "odd client", pid=7010, client_id=[1])
    assert find_stream_serial([*DUMP, odd], 7010) == 1346


def test_a_stream_without_a_serial_is_skipped():
    no_serial = node(307, 1, "x", pid=7008)
    del no_serial["info"]["props"]["object.serial"]
    assert parse_audio_apps([*DUMP, no_serial], own_pid=9999) == parse_audio_apps(DUMP, 9999)


def test_a_dump_that_is_not_a_list_lists_nothing():
    assert (
        parse_audio_apps(
            {"error": "nope"},  # pyright: ignore[reportArgumentType]
            own_pid=1,
        )
        == []
    )
    assert (
        find_stream_serial(
            {"error": "nope"},  # pyright: ignore[reportArgumentType]
            2016,
        )
        is None
    )


# --- pw-dump missing or broken --------------------------------------------------------------


@pytest.fixture
def no_pw_dump(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tidalviz.capture.pipewire_source as ps

    monkeypatch.setenv("PATH", str(tmp_path))  # an empty directory: no pw-dump anywhere
    monkeypatch.setattr(ps, "_warned_no_pw_dump", False)


def test_a_missing_pw_dump_lists_nothing_and_warns_once(
    no_pw_dump: None, caplog: pytest.LogCaptureFixture
):
    with caplog.at_level("WARNING"):
        assert list_audio_apps() == []
        assert list_audio_apps() == []
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert [r.getMessage() for r in warnings] == ["pw-dump not found; per-app capture unavailable"]
    assert not any(r.exc_info for r in caplog.records)


def test_other_pw_dump_failures_are_not_swallowed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import subprocess

    script = tmp_path / "pw-dump"
    script.write_text("#!/bin/sh\nexit 3\n")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(subprocess.CalledProcessError):
        list_audio_apps()


def test_make_source_for_an_app_without_pw_dump_raises_what_the_host_handles(no_pw_dump: None):
    from tidalviz.host import make_source

    with pytest.raises(StopIteration):  # host.py catches (ValueError, StopIteration)
        make_source("app:1234")
