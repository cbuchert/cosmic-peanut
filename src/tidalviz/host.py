"""The host core: wires settings, registry, servers, audio pipeline and dev watcher.

GUI-free so it can be tested with a real WebSocket client; the window is injected as a
`WindowControl` (tidalviz.window implements it with pywebview).
"""

import asyncio
import contextlib
import logging
import struct
import subprocess
import time
from collections import deque
from collections.abc import Callable, Coroutine, Sequence
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import psutil

from tidalviz.capture import (
    AudioSource,
    CatapAppSource,
    CatapSystemSource,
    SyntheticSource,
    list_audio_apps,
)
from tidalviz.pipeline import AudioPipeline
from tidalviz.plugins import DevFolderWatcher, ManifestError, PluginRegistry
from tidalviz.plugins.git import GitFetcher
from tidalviz.plugins.registry import PendingInstall
from tidalviz.server.runner import DEFAULT_WEB_DIR, HostServers
from tidalviz.settings import Settings
from tidalviz.transport.control import HANG_AFTER_S, TextSocket

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
THROTTLED_FPS = 40  # WebKit runs a never-clicked cross-origin iframe's rAF at 20 Hz
CLICK_INTERVAL_S = 2.0
STATS_INTERVAL_S = 1.0
# System Settings → Privacy & Security → Screen & System Audio Recording (process taps).
PERMISSIONS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
# Settings the shell owns; anything else in a `settings` message is ignored.
SHELL_SETTINGS = (
    "quality",
    "reduceFlashing",
    "autoCycleSeconds",
    "hudVisible",
    "photosensitivityNoticeSeen",
)


class WindowControl(Protocol):
    def fullscreen(self) -> None: ...
    def float_on_top(self) -> None: ...
    def borderless(self) -> None: ...
    def quit(self) -> None: ...
    def click_plugin(self) -> None: ...
    def recover_webview(self) -> None: ...
    def pick_folder(self) -> str | None: ...


def open_url(url: str) -> None:
    subprocess.run(["/usr/bin/open", url], check=False)


def make_source(source_id: str) -> AudioSource:
    """`system`, `app:<pid>` or `synthetic:<kind>` → a capture source."""
    if source_id == "system":
        return CatapSystemSource()
    if source_id.startswith("app:"):
        pid = int(source_id.removeprefix("app:"))
        app = next(a for a in list_audio_apps() if a.pid == pid)
        return CatapAppSource(app.name)
    if source_id.startswith("synthetic:"):
        return SyntheticSource(source_id.removeprefix("synthetic:"))
    raise ValueError(f"unknown source {source_id!r}")


class Host:
    def __init__(
        self,
        *,
        root: Path,
        builtin_dirs: Sequence[Path],
        window: WindowControl,
        source_id: str | None = None,
        web_dir: Path = DEFAULT_WEB_DIR,
        dev: bool = False,
        hang_after: float = HANG_AFTER_S,
        fetcher: GitFetcher | None = None,
        open_url: Callable[[str], None] = open_url,
    ) -> None:
        root.mkdir(parents=True, exist_ok=True)
        self.settings = Settings(root / "settings.json")
        if source_id is not None:
            self.settings.data["source"] = source_id  # this launch only; not persisted
        self.registry = PluginRegistry(root, builtin_dirs, fetcher=fetcher)
        self.window = window
        self._open_url = open_url
        self.dev = dev
        self.servers = HostServers(
            self.registry,
            web_dir=web_dir,
            dev=dev,
            on_message=self._on_message,
            on_client_count=self._on_client_count,
            on_connect=self._on_connect,
            on_hang=self._on_hang,
            hang_after=hang_after,
        )
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_click = -CLICK_INTERVAL_S
        self._tasks: set[asyncio.Future[Any]] = set()
        self._notices: list[dict[str, Any]] = []  # sent to the next shell after its hello
        # Onset frames published (index, host time) — appended on the analysis thread; deque
        # appends are atomic. Latency = when the shell reports seeing one, minus its time.
        self._onsets: deque[tuple[int, float]] = deque(maxlen=64)
        self._latency_ms: deque[float] = deque(maxlen=256)
        self._process = psutil.Process()
        self._stats_task: asyncio.Task[None] | None = None
        self.watcher = DevFolderWatcher(
            self._dev_changed,
            revalidate=self.registry.reload,
            on_manifest_errors=self._dev_manifest_errors,
        )
        self.pipeline: AudioPipeline | None = None

    # --- lifecycle ------------------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        await self.servers.start()
        self.pipeline = AudioPipeline(make_source(self.settings.data["source"]), self._publish)
        self.pipeline.pause()  # resumed when a shell connects
        self.pipeline.start()
        for key, folder in self.registry.dev_folders().items():
            self.watcher.add(key, folder)
        self.watcher.start()
        self._process.cpu_percent(None)  # prime: the first call always returns 0
        self._stats_task = asyncio.create_task(self._stats_loop())

    async def stop(self) -> None:
        if self._stats_task is not None:
            self._stats_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stats_task
        await asyncio.to_thread(self.watcher.stop)
        if self.pipeline is not None:
            await asyncio.to_thread(self.pipeline.stop)
        await self.servers.stop()

    def _publish(self, data: bytes) -> None:
        """Analysis thread → event loop; the hub keeps only the newest frame."""
        if data[6] & 1:  # onset flag (protocols §1)
            (index,) = struct.unpack_from("<I", data, 8)
            (host_time,) = struct.unpack_from("<d", data, 16)
            self._onsets.append((index, host_time))
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self.servers.hub.publish, data)

    def use_dev_folder(self, folder: Path) -> str:
        """Register a plugin folder in place and make its first visualizer active."""
        repo = self.registry.add_dev_folder(folder)
        key = next(v["key"] for v in self.registry.visualizers() if v["repo"] == repo)
        self.settings.update({"active": key})
        return key

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> None:
        """Run a coroutine on the loop, keeping a reference until it finishes."""
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _broadcast_threadsafe(self, msg: dict[str, Any]) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(lambda: self._spawn(self.servers.control.broadcast_json(msg)))

    def _dev_changed(self, repo: str, paths: list[Path]) -> None:
        """Watcher thread: a dev folder changed → hot-reload its visualizers."""
        for v in self.registry.visualizers():
            if v["repo"] == repo:
                self._broadcast_threadsafe({"type": "reload", "key": v["key"]})

    def _dev_manifest_errors(self, repo: str, errors: list[ManifestError]) -> None:
        self._broadcast_threadsafe(
            {
                "type": "manifestError",
                "repo": repo,
                "errors": [{"path": e.path, "message": e.message} for e in errors],
            }
        )

    # --- composition ----------------------------------------------------------------------

    def visualizers(self) -> list[dict[str, Any]]:
        origin = self.servers.plugin_origin
        out: list[dict[str, Any]] = []
        for v in self.registry.visualizers():
            repo, thumb = v["repo"], v.get("thumbnail")
            values = {p["id"]: p["default"] for p in v["params"]}
            values.update(self.settings.params_for(v["key"]))
            out.append(
                {
                    **v,
                    "values": values,
                    "pageUrl": f"{origin}/v/{repo}/{v['id']}/",
                    "entryUrl": f"{origin}/r/{repo}/{v['entry']}",
                    "thumbnailUrl": f"{origin}/r/{repo}/{thumb}" if thumb else None,
                }
            )
        return out

    def sources(self) -> list[dict[str, str]]:
        out = [{"id": "system", "name": "All audio"}]
        try:
            out += [{"id": a.id, "name": a.name} for a in list_audio_apps()]
        except Exception:
            log.exception("listing audio apps failed")
        out.append({"id": "synthetic:demo", "name": "Demo (synthetic)"})
        return out

    def hello(self) -> dict[str, Any]:
        s = self.settings.data
        return {
            "type": "hello",
            "version": PROTOCOL_VERSION,
            "pluginOrigin": self.servers.plugin_origin,
            "visualizers": self.visualizers(),
            "repos": self.registry.repos(),
            "settings": {k: v for k, v in s.items() if k not in ("params", "window")},
            "sources": self.sources(),
            "activeSource": s["source"],
            "active": s["active"],
            "dev": self.dev,
        }

    # --- control channel ------------------------------------------------------------------

    def _on_connect(self, client: TextSocket) -> None:
        self._spawn(self._greet(client))

    async def _greet(self, client: TextSocket) -> None:
        await self.servers.control.send_json(client, self.hello())
        notices, self._notices = self._notices, []
        for msg in notices:
            await self.servers.control.send_json(client, msg)

    def _on_hang(self) -> None:
        """No heartbeat for 2 s: a plugin froze the shared WebContent process (spike).
        Disable the active visualizer so the reload doesn't hang again, then kill-and-reset."""
        key = self.settings.data["active"]
        if key is not None:
            self.registry.disable(key)
            self._notices.append(
                {
                    "type": "disabled",
                    "key": key,
                    "reason": "It froze the window, so Tidalviz reloaded without it.",
                }
            )
        log.warning("shell stopped responding; recovering (disabled %s)", key)
        self.window.recover_webview()

    def _on_client_count(self, n: int) -> None:
        if self.pipeline is not None:
            if n:
                self.pipeline.resume()
            else:
                self.pipeline.pause()

    def _on_message(self, client: TextSocket, msg: dict[str, Any]) -> None:
        match msg["type"]:
            case "select":
                self.settings.update({"active": msg["key"]})
            case "params":
                self.settings.set_params(msg["key"], msg["values"])
            case "perf":
                self._maybe_click(msg["fps"])
            case "onsetSeen":
                self._onset_seen(msg["frameIndex"])
            case "setSource":
                self._set_source(msg["id"])
            case "enable":
                self.registry.enable(msg["key"])
                self._spawn(self._broadcast_visualizers())
            case "settings":
                self.settings.update({k: v for k, v in msg.items() if k in SHELL_SETTINGS})
            case "install":
                self._spawn(self._prompt(self.registry.prepare_install, msg["url"]))
            case "update":
                self._spawn(self._prompt(self.registry.update, msg["repo"]))
            case "installConfirm":
                self._spawn(self._confirm(msg["id"], msg["accept"]))
            case "rollback":
                self._spawn(self._registry_op("Rollback", self.registry.rollback, msg["repo"]))
            case "remove":
                self._spawn(self._registry_op("Remove", self.registry.remove, msg["repo"]))
            case "openPermissions":
                self._open_url(PERMISSIONS_URL)
            case "addFolder":
                self._spawn(self._add_folder(msg.get("path")))
            case "window":
                self._window_action(msg["action"])
            case _:
                pass

    def _maybe_click(self, fps: float) -> None:
        """Lift WebKit's 20 Hz throttle on a fresh plugin iframe with one native click."""
        now = asyncio.get_running_loop().time()
        if 0 < fps < THROTTLED_FPS and now - self._last_click >= CLICK_INTERVAL_S:
            self._last_click = now
            self.window.click_plugin()

    def _window_action(self, action: str) -> None:
        actions = {
            "fullscreen": self.window.fullscreen,
            "floatOnTop": self.window.float_on_top,
            "borderless": self.window.borderless,
            "quit": self.window.quit,
        }
        if (fn := actions.get(action)) is not None:
            fn()

    async def _broadcast_visualizers(self) -> None:
        await self.servers.control.broadcast_json(
            {
                "type": "visualizers",
                "visualizers": self.visualizers(),
                "repos": self.registry.repos(),
            }
        )

    def _set_source(self, source_id: str) -> None:
        try:
            source = make_source(source_id)
        except (ValueError, StopIteration):
            self._spawn(
                self.servers.control.broadcast_json(
                    {
                        "type": "status",
                        "level": "error",
                        "text": f"Unknown audio source: {source_id}",
                    }
                )
            )
            return
        if self.pipeline is not None:
            self.pipeline.switch_source(source)
        self.settings.update({"source": source_id})
        self._spawn(
            self.servers.control.broadcast_json(
                {"type": "sources", "sources": self.sources(), "active": source_id}
            )
        )

    def _onset_seen(self, index: int) -> None:
        now = time.monotonic()
        for i, host_time in reversed(self._onsets):
            if i == index:
                self._latency_ms.append((now - host_time) * 1000)
                return

    def stats(self) -> dict[str, Any]:
        p = self.pipeline.stats() if self.pipeline is not None else None
        out: dict[str, Any] = {
            "type": "stats",
            "hostCpu": self._process.cpu_percent(None),
            "rssMb": self._process.memory_info().rss / 1e6,
            "analysisMsP50": p.analysis_ms_p50 if p else 0.0,
            "captureToSendMsP95": p.capture_to_send_ms_p95 if p else 0.0,
            "droppedFrames": (p.dropped_frames if p else 0) + self.servers.hub.total_dropped,
        }
        if self._latency_ms:
            out["latencyMsP95"] = float(np.percentile(self._latency_ms, 95))
        return out

    async def _stats_loop(self) -> None:
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            if self.servers.control.client_count:
                await self.servers.control.broadcast_json(self.stats())

    # --- installs (blocking registry work runs in a thread) --------------------------------

    async def _send_all(self, msg: dict[str, Any]) -> None:
        await self.servers.control.broadcast_json(msg)

    async def _prompt(self, prepare: Callable[[str], PendingInstall], arg: str) -> None:
        """Fetch + validate, then show the trust prompt (install and update share this)."""
        try:
            pending = await asyncio.to_thread(prepare, arg)
        except Exception as e:  # user-facing boundary: report, don't crash the loop
            log.warning("install of %s failed: %s", arg, e)
            await self._send_all({"type": "installResult", "id": "", "ok": False, "error": str(e)})
            return
        await self._send_all(
            {
                "type": "installPrompt",
                "id": pending.id,
                "url": pending.spec.url,
                "commit": pending.commit,
                "visualizers": [{"id": v["id"], "name": v["name"]} for v in pending.visualizers],
            }
        )

    async def _confirm(self, pending_id: str, accept: bool) -> None:
        if not accept:
            await asyncio.to_thread(self.registry.cancel_install, pending_id)
            await self._send_all(
                {"type": "installResult", "id": pending_id, "ok": False, "error": "Cancelled"}
            )
            return
        try:
            await asyncio.to_thread(self.registry.confirm_install, pending_id)
        except Exception as e:
            await self._send_all(
                {"type": "installResult", "id": pending_id, "ok": False, "error": str(e)}
            )
            return
        await self._send_all({"type": "installResult", "id": pending_id, "ok": True})
        await self._broadcast_visualizers()

    async def _registry_op(self, what: str, fn: Callable[[str], Any], repo: str) -> None:
        try:
            await asyncio.to_thread(fn, repo)
        except Exception as e:
            await self._send_all(
                {"type": "status", "level": "error", "text": f"{what} failed: {e}"}
            )
            return
        await self._broadcast_visualizers()

    async def _add_folder(self, path: str | None) -> None:
        if path is None:
            path = await asyncio.to_thread(self.window.pick_folder)
            if path is None:
                return
        try:
            key = await asyncio.to_thread(self.registry.add_dev_folder, Path(path))
        except Exception as e:
            await self._send_all(
                {"type": "status", "level": "error", "text": f"Add folder failed: {e}"}
            )
            return
        self.watcher.add(key, Path(path))
        await self._broadcast_visualizers()
