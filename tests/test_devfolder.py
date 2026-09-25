"""DevFolderWatcher: watchfiles in a background thread, debounced per-repo change callbacks."""

from __future__ import annotations

import statistics
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from tests.test_registry import write_plugin
from tidalviz.plugins.devfolder import DevFolderWatcher
from tidalviz.plugins.manifest import ManifestError
from tidalviz.plugins.registry import PluginRegistry


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[Path]]] = []
        self.errors: list[tuple[str, list[ManifestError]]] = []
        self.event = threading.Event()

    def on_change(self, key: str, paths: list[Path]) -> None:
        self.calls.append((key, paths))
        self.event.set()

    def on_errors(self, key: str, errors: list[ManifestError]) -> None:
        self.errors.append((key, errors))
        self.event.set()

    def wait(self, timeout: float = 3.0) -> bool:
        ok = self.event.wait(timeout)
        self.event.clear()
        return ok


def settle(rec: Recorder, touch: Callable[[], None]) -> None:
    """Poke the folder until the watcher reports, so later measurements don't include startup."""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        touch()
        if rec.wait(0.3):
            time.sleep(0.1)
            rec.calls.clear()
            rec.errors.clear()
            rec.event.clear()
            return
    raise AssertionError("watcher never became ready")


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


def test_change_is_reported_per_repo_with_paths(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    b = write_plugin(tmp_path / "b", "wave").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.add("dev-a", a)
    w.add("dev-b", b)
    w.start()
    try:
        settle(rec, lambda: (a / "src/pulse.js").write_text("// warm"))
        (b / "src/wave.js").write_text("// edit")
        assert rec.wait()
        key, paths = rec.calls[-1]
        assert key == "dev-b"
        assert b / "src/wave.js" in paths
    finally:
        w.stop()


def test_burst_of_saves_is_debounced(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.add("dev-a", a)
    w.start()
    try:
        settle(rec, lambda: (a / "src/pulse.js").write_text("// warm"))
        for i in range(5):
            (a / f"f{i}.js").write_text("x")
        assert rec.wait()
        time.sleep(0.3)
        assert len(rec.calls) <= 2
        changed = {p.name for _, paths in rec.calls for p in paths}
        assert {f"f{i}.js" for i in range(5)} <= changed
    finally:
        w.stop()


def test_add_and_remove_at_runtime(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    b = write_plugin(tmp_path / "b", "wave").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.add("dev-a", a)
    w.start()
    try:
        w.add("dev-b", b)
        settle(rec, lambda: (b / "src/wave.js").write_text("// warm"))
        w.remove("dev-a")
        time.sleep(0.2)
        (a / "src/pulse.js").write_text("// ignored")
        time.sleep(0.4)
        assert all(k != "dev-a" for k, _ in rec.calls)
        assert w.folders == {"dev-b": b}
    finally:
        w.stop()


def test_stop_is_clean_and_idempotent(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.add("dev-a", a)
    w.start()
    t0 = time.monotonic()
    w.stop()
    w.stop()
    assert time.monotonic() - t0 < 2
    assert not any(t.name == "tidalviz-devwatch" and t.is_alive() for t in threading.enumerate())


def test_start_without_folders_then_add(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.start()
    try:
        w.add("dev-a", a)
        settle(rec, lambda: (a / "src/pulse.js").write_text("// warm"))
    finally:
        w.stop()


def test_manifest_errors_are_reported_not_dropped(tmp_path: Path, rec: Recorder) -> None:
    folder = write_plugin(tmp_path / "viz", "pulse").resolve()
    reg = PluginRegistry(tmp_path / "support", [])
    key = reg.add_dev_folder(folder)
    w = DevFolderWatcher(rec.on_change, revalidate=reg.reload, on_manifest_errors=rec.on_errors)
    w.add(key, folder)
    w.start()
    try:
        settle(rec, lambda: (folder / "src/pulse.js").write_text("// warm"))
        (folder / "tidalviz.json").write_text("{ nope")
        deadline = time.monotonic() + 3
        while not rec.errors and time.monotonic() < deadline:
            rec.wait(0.5)
        assert rec.errors and rec.errors[-1][0] == key
        assert rec.errors[-1][1][0].path == "tidalviz.json"
        assert not rec.calls  # broken manifest: no reload, last good version keeps running
        assert reg.entry(key, "pulse") is not None
        write_plugin(folder, "pulse")
        deadline = time.monotonic() + 3
        while not rec.calls and time.monotonic() < deadline:
            rec.wait(0.5)
        assert rec.calls and rec.calls[-1][0] == key
    finally:
        w.stop()


def test_save_to_callback_latency(tmp_path: Path, rec: Recorder) -> None:
    a = write_plugin(tmp_path / "a", "pulse").resolve()
    w = DevFolderWatcher(rec.on_change)
    w.add("dev-a", a)
    w.start()
    try:
        settle(rec, lambda: (a / "src/pulse.js").write_text("// warm"))
        samples: list[float] = []
        for i in range(10):
            t0 = time.perf_counter()
            (a / "src/pulse.js").write_text(f"// save {i}")
            assert rec.wait()
            samples.append((time.perf_counter() - t0) * 1000)
            time.sleep(0.15)
        p50, worst = statistics.median(samples), max(samples)
        print(f"\ndev-folder save->callback latency: p50 {p50:.0f} ms, max {worst:.0f} ms")
        assert p50 < 150
        assert worst < 250
    finally:
        w.stop()
