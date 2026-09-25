"""The host core: control messages, persistence, frames, window actions (no GUI)."""

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiohttp
import pytest
import pytest_asyncio

from tidalviz.host import Host

REPO = Path(__file__).resolve().parent.parent
BUILTINS = [REPO / "plugins" / "builtin", REPO / "plugins" / "template"]


class FakeWindow:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def fullscreen(self) -> None:
        self.calls.append("fullscreen")

    def float_on_top(self) -> None:
        self.calls.append("floatOnTop")

    def borderless(self) -> None:
        self.calls.append("borderless")

    def quit(self) -> None:
        self.calls.append("quit")

    def click_plugin(self) -> None:
        self.calls.append("click")

    def recover_webview(self) -> None:
        self.calls.append("recover")

    def pick_folder(self) -> str | None:
        return None


class Shell:
    """A test stand-in for the web shell: one control WebSocket."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        self.ws = ws
        self.frames = 0

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send_str(json.dumps(msg))

    async def next_json(self, type_: str, timeout: float = 3.0) -> dict[str, Any]:
        async with asyncio.timeout(timeout):
            while True:
                m = await self.ws.receive()
                if m.type == aiohttp.WSMsgType.BINARY:
                    self.frames += 1
                    continue
                if m.type != aiohttp.WSMsgType.TEXT:
                    raise AssertionError(f"socket closed: {m.type}")
                data = json.loads(m.data)
                if data["type"] == type_:
                    return data

    async def count_frames(self, seconds: float) -> int:
        n = 0
        end = asyncio.get_running_loop().time() + seconds
        while (left := end - asyncio.get_running_loop().time()) > 0:
            try:
                m = await self.ws.receive(timeout=left)
            except TimeoutError:
                break
            if m.type == aiohttp.WSMsgType.BINARY:
                n += 1
        return n


@pytest.fixture
def window() -> FakeWindow:
    return FakeWindow()


@pytest_asyncio.fixture
async def host(tmp_path: Path, window: FakeWindow) -> AsyncIterator[Host]:
    h = Host(
        root=tmp_path / "home", builtin_dirs=BUILTINS, source_id="synthetic:demo", window=window
    )
    await h.start()
    yield h
    await h.stop()


@pytest_asyncio.fixture
async def http() -> AsyncIterator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession() as s:
        yield s


async def connect(host: Host, http: aiohttp.ClientSession) -> Shell:
    s = host.servers
    ws = await http.ws_connect(f"{s.shell_origin}/ws?token={s.token}", origin=s.shell_origin)
    return Shell(ws)


@pytest.mark.asyncio
async def test_hello_describes_builtins_with_urls_and_default_values(host: Host, http):
    shell = await connect(host, http)
    hello = await shell.next_json("hello")
    assert hello["version"] == 1 and hello["pluginOrigin"] == host.servers.plugin_origin
    viz = {v["key"]: v for v in hello["visualizers"]}
    assert {"builtin/bars", "builtin/undertow", "builtin/orbit"} <= viz.keys()
    bars = viz["builtin/bars"]
    assert bars["pageUrl"] == f"{host.servers.plugin_origin}/v/builtin/bars/"
    assert bars["entryUrl"].startswith(f"{host.servers.plugin_origin}/r/builtin/")
    assert bars["thumbnailUrl"].startswith(f"{host.servers.plugin_origin}/r/builtin/")
    assert bars["values"] == {p["id"]: p["default"] for p in bars["params"]}
    assert hello["settings"]["reduceFlashing"] is True
    assert hello["activeSource"] == "synthetic:demo"
    assert {"id": "system", "name": "All audio"} in hello["sources"]


@pytest.mark.asyncio
async def test_select_and_params_persist_across_restarts(tmp_path: Path, window: FakeWindow, http):
    root = tmp_path / "home"
    h = Host(root=root, builtin_dirs=BUILTINS, source_id="synthetic:demo", window=window)
    await h.start()
    shell = await connect(h, http)
    await shell.next_json("hello")
    await shell.send({"type": "select", "key": "builtin/orbit"})
    await shell.send({"type": "params", "key": "builtin/bars", "values": {"mirror": True}})
    await asyncio.sleep(0.1)
    await shell.ws.close()
    await h.stop()

    h2 = Host(root=root, builtin_dirs=BUILTINS, source_id="synthetic:demo", window=window)
    await h2.start()
    try:
        hello = await (await connect(h2, http)).next_json("hello")
        assert hello["active"] == "builtin/orbit"
        bars = next(v for v in hello["visualizers"] if v["key"] == "builtin/bars")
        assert bars["values"]["mirror"] is True
    finally:
        await h2.stop()


@pytest.mark.asyncio
async def test_frames_stream_while_a_shell_is_connected(host: Host, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    n = await shell.count_frames(1.0)
    assert 60 <= n <= 110  # ~94 frames/s from the synthetic source


def perf(fps: float) -> dict[str, Any]:
    return {
        "type": "perf",
        "key": "builtin/bars",
        "fps": fps,
        "frameMsP50": 1.0,
        "frameMsP99": 2.0,
        "pluginMsP50": 0.1,
        "shellMs": 0.0,
        "renderScale": 1.0,
        "dropped": 0,
    }


@pytest.mark.asyncio
async def test_throttled_plugin_fps_triggers_one_native_click(host: Host, window: FakeWindow, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send(perf(20))  # WebKit's non-interacted cross-origin iframe rate
    await shell.send(perf(20))  # rate-limited: no second click right away
    await shell.send(perf(60))
    await asyncio.sleep(0.2)
    assert window.calls.count("click") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("action", "call"),
    [("fullscreen", "fullscreen"), ("floatOnTop", "floatOnTop"), ("borderless", "borderless"),
     ("quit", "quit")],
)  # fmt: skip
async def test_window_actions_reach_the_window(
    host: Host, window: FakeWindow, http, action: str, call: str
):
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "window", "action": action})
    await asyncio.sleep(0.2)
    assert window.calls == [call]


def write_dev_plugin(folder: Path) -> None:
    (folder / "src").mkdir(parents=True)
    (folder / "tidalviz.json").write_text(
        json.dumps(
            {
                "apiVersion": 1,
                "visualizers": [
                    {"id": "pulse", "name": "Pulse", "entry": "src/main.js", "renderer": "2d"}
                ],
            }
        )
    )
    (folder / "src" / "main.js").write_text("export default () => ({ frame() {} });\n")


@pytest.mark.asyncio
async def test_dev_folder_becomes_active_and_hot_reloads(tmp_path: Path, window: FakeWindow, http):
    folder = tmp_path / "my-viz"
    write_dev_plugin(folder)
    h = Host(
        root=tmp_path / "home", builtin_dirs=BUILTINS, source_id="synthetic:demo", window=window
    )
    key = h.use_dev_folder(folder)
    await h.start()
    try:
        shell = await connect(h, http)
        hello = await shell.next_json("hello")
        assert hello["active"] == key and key.endswith("/pulse")
        assert next(v for v in hello["visualizers"] if v["key"] == key)["dev"] is True
        await asyncio.sleep(0.3)  # let the watcher start
        (folder / "src" / "main.js").write_text("export default () => ({ frame() {} }); // v2\n")
        reload = await shell.next_json("reload", timeout=2.0)
        assert reload["key"] == key
    finally:
        await h.stop()
