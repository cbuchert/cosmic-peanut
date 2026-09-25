"""The host core: wires settings, registry, servers, audio pipeline and dev watcher.

GUI-free so it can be tested with a real WebSocket client; the window is injected as a
`WindowControl` (tidalviz.window implements it with pywebview).
"""

import asyncio
import logging
from collections.abc import Coroutine, Sequence
from pathlib import Path
from typing import Any, Protocol

from tidalviz.capture import (
    AudioSource,
    CatapAppSource,
    CatapSystemSource,
    SyntheticSource,
    list_audio_apps,
)
from tidalviz.pipeline import AudioPipeline
from tidalviz.plugins import DevFolderWatcher, ManifestError, PluginRegistry
from tidalviz.server.runner import DEFAULT_WEB_DIR, HostServers
from tidalviz.settings import Settings
from tidalviz.transport.control import TextSocket

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
THROTTLED_FPS = 40  # WebKit runs a never-clicked cross-origin iframe's rAF at 20 Hz
CLICK_INTERVAL_S = 2.0


class WindowControl(Protocol):
    def fullscreen(self) -> None: ...
    def float_on_top(self) -> None: ...
    def borderless(self) -> None: ...
    def quit(self) -> None: ...
    def click_plugin(self) -> None: ...
    def recover_webview(self) -> None: ...
    def pick_folder(self) -> str | None: ...


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
    ) -> None:
        root.mkdir(parents=True, exist_ok=True)
        self.settings = Settings(root / "settings.json")
        if source_id is not None:
            self.settings.data["source"] = source_id  # this launch only; not persisted
        self.registry = PluginRegistry(root, builtin_dirs)
        self.window = window
        self.dev = dev
        self.servers = HostServers(
            self.registry,
            web_dir=web_dir,
            dev=dev,
            on_message=self._on_message,
            on_client_count=self._on_client_count,
            on_connect=self._on_connect,
        )
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_click = -CLICK_INTERVAL_S
        self._tasks: set[asyncio.Future[Any]] = set()
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

    async def stop(self) -> None:
        await asyncio.to_thread(self.watcher.stop)
        if self.pipeline is not None:
            await asyncio.to_thread(self.pipeline.stop)
        await self.servers.stop()

    def _publish(self, data: bytes) -> None:
        """Analysis thread → event loop; the hub keeps only the newest frame."""
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
        self._spawn(self.servers.control.send_json(client, self.hello()))

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
