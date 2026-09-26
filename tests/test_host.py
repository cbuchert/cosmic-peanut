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


@pytest.mark.asyncio
async def test_missed_heartbeats_disable_the_active_visualizer_and_recover(
    tmp_path: Path, window: FakeWindow, http
):
    h = Host(
        root=tmp_path / "home",
        builtin_dirs=BUILTINS,
        source_id="synthetic:demo",
        window=window,
        hang_after=0.3,
    )
    await h.start()
    try:
        shell = await connect(h, http)
        await shell.next_json("hello")
        await shell.send({"type": "select", "key": "builtin/orbit"})
        await asyncio.sleep(0.8)  # no heartbeats: the watchdog fires
        assert window.calls.count("recover") == 1
        await shell.ws.close()

        again = await connect(h, http)  # the reloaded web view reconnects
        hello = await again.next_json("hello")
        orbit = next(v for v in hello["visualizers"] if v["key"] == "builtin/orbit")
        assert orbit["disabled"] is True
        disabled = await again.next_json("disabled")
        assert disabled["key"] == "builtin/orbit" and "froze" in disabled["reason"]
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_set_source_switches_capture_and_persists(host: Host, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "setSource", "id": "synthetic:click120"})
    msg = await shell.next_json("sources")
    assert msg["active"] == "synthetic:click120"
    assert host.settings.data["source"] == "synthetic:click120"
    assert host.pipeline is not None
    assert getattr(host.pipeline.source, "kind", None) == "click120"


@pytest.mark.asyncio
async def test_unknown_source_is_rejected_with_a_status(host: Host, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "setSource", "id": "synthetic:nope"})
    status = await shell.next_json("status")
    assert status["level"] == "error"
    assert host.settings.data["source"] == "synthetic:demo"


@pytest.mark.asyncio
async def test_enable_reenables_a_disabled_visualizer(host: Host, http):
    host.registry.disable("builtin/bars")
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "enable", "key": "builtin/bars"})
    msg = await shell.next_json("visualizers")
    bars = next(v for v in msg["visualizers"] if v["key"] == "builtin/bars")
    assert bars["disabled"] is False


@pytest.mark.asyncio
async def test_settings_persist_only_shell_owned_keys(host: Host, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send(
        {"type": "settings", "quality": "battery", "hudVisible": True, "source": "system"}
    )
    await asyncio.sleep(0.1)
    assert host.settings.data["quality"] == "battery" and host.settings.data["hudVisible"]
    assert host.settings.data["source"] == "synthetic:demo"


@pytest.mark.asyncio
async def test_stats_are_broadcast_with_onset_latency(tmp_path: Path, window: FakeWindow, http):
    h = Host(
        root=tmp_path / "home", builtin_dirs=BUILTINS, source_id="synthetic:click120", window=window
    )
    await h.start()
    try:
        shell = await connect(h, http)
        await shell.next_json("hello")
        # Echo onsetSeen for the first onset frame we receive, like the SDK does.
        async with asyncio.timeout(3):
            while True:
                m = await shell.ws.receive()
                if m.type == aiohttp.WSMsgType.BINARY and m.data[6] & 1:
                    index = int.from_bytes(m.data[8:12], "little")
                    await shell.send({"type": "onsetSeen", "frameIndex": index})
                    break
        stats = await shell.next_json("stats", timeout=2.5)
        for k in ("hostCpu", "rssMb", "analysisMsP50", "captureToSendMsP95", "droppedFrames"):
            assert isinstance(stats[k], (int, float)), k
        assert 0 <= stats["latencyMsP95"] < 50
    finally:
        await h.stop()


# --- install flow (local fixture repos; no network) -----------------------------------------

from tests.test_git_fetch import commit_files, plugin_files  # noqa: E402
from tidalviz.plugins.git import GitFetcher, local_transport  # noqa: E402

VIZ_URL = "https://example.com/me/viz"


@pytest_asyncio.fixture
async def installer(tmp_path: Path, window: FakeWindow) -> AsyncIterator[tuple[Host, Path]]:
    origin = tmp_path / "origin"
    commit_files(origin, plugin_files("waves"), "first")
    home = tmp_path / "home"
    fetcher = GitFetcher(home / "cache", transport=local_transport({VIZ_URL: origin}))
    h = Host(
        root=home, builtin_dirs=BUILTINS, source_id="synthetic:demo", window=window, fetcher=fetcher
    )
    await h.start()
    yield h, origin
    await h.stop()


async def install_via_shell(shell: Shell, accept: bool = True) -> dict[str, Any]:
    await shell.send({"type": "install", "url": VIZ_URL})
    prompt = await shell.next_json("installPrompt")
    await shell.send({"type": "installConfirm", "id": prompt["id"], "accept": accept})
    return prompt


@pytest.mark.asyncio
async def test_install_prompts_then_registers_on_accept(installer, http):
    host, _ = installer
    shell = await connect(host, http)
    await shell.next_json("hello")
    prompt = await install_via_shell(shell)
    assert prompt["url"] == VIZ_URL and len(prompt["commit"]) == 40
    assert [v["id"] for v in prompt["visualizers"]] == ["waves"]
    result = await shell.next_json("installResult")
    assert result == {"type": "installResult", "id": prompt["id"], "ok": True}
    viz = await shell.next_json("visualizers")
    assert any(v["id"] == "waves" for v in viz["visualizers"])


@pytest.mark.asyncio
async def test_declining_the_trust_prompt_installs_nothing(installer, http):
    host, _ = installer
    shell = await connect(host, http)
    await shell.next_json("hello")
    prompt = await install_via_shell(shell, accept=False)
    result = await shell.next_json("installResult")
    assert result["id"] == prompt["id"] and result["ok"] is False
    assert not any(v["id"] == "waves" for v in host.visualizers())


@pytest.mark.asyncio
async def test_bad_url_reports_an_install_error(installer, http):
    host, _ = installer
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "install", "url": "git@github.com:me/viz.git"})
    result = await shell.next_json("installResult")
    assert result["ok"] is False and result["error"]


@pytest.mark.asyncio
async def test_update_then_rollback_then_remove(installer, http):
    host, origin = installer
    shell = await connect(host, http)
    await shell.next_json("hello")
    first = await install_via_shell(shell)
    await shell.next_json("installResult")
    await shell.next_json("visualizers")  # the install's broadcast
    repo = next(v["repo"] for v in host.visualizers() if v["id"] == "waves")

    commit_files(origin, {"src/waves.js": "// v2\n"}, "second")
    await shell.send({"type": "update", "repo": repo})
    second = await shell.next_json("installPrompt")
    assert second["commit"] != first["commit"]
    await shell.send({"type": "installConfirm", "id": second["id"], "accept": True})
    await shell.next_json("installResult")
    await shell.next_json("visualizers")  # the update's broadcast

    await shell.send({"type": "rollback", "repo": repo})
    viz = await shell.next_json("visualizers")
    info = next(r for r in viz["repos"] if r["repo"] == repo)
    assert info["commit"] == first["commit"]

    await shell.send({"type": "remove", "repo": repo})
    viz = await shell.next_json("visualizers")
    assert not any(v["repo"] == repo for v in viz["visualizers"])


@pytest.mark.asyncio
async def test_add_folder_with_a_path_registers_a_dev_repo(installer, http, tmp_path: Path):
    host, _ = installer
    folder = tmp_path / "mine"
    write_dev_plugin(folder)
    shell = await connect(host, http)
    await shell.next_json("hello")
    await shell.send({"type": "addFolder", "path": str(folder)})
    viz = await shell.next_json("visualizers")
    assert any(v["id"] == "pulse" and v["dev"] for v in viz["visualizers"])


@pytest.mark.asyncio
async def test_open_permissions_opens_the_audio_capture_privacy_pane(
    tmp_path: Path, window: FakeWindow, http
):
    opened: list[str] = []
    h = Host(
        root=tmp_path / "home",
        builtin_dirs=BUILTINS,
        source_id="synthetic:demo",
        window=window,
        open_url=opened.append,
    )
    await h.start()
    try:
        shell = await connect(h, http)
        await shell.next_json("hello")
        await shell.send({"type": "openPermissions"})
        await asyncio.sleep(0.2)
        assert opened == [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        ]
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_plugin_rate_changes_are_logged_once_per_crossing(
    host: Host, http, caplog: pytest.LogCaptureFixture
):
    shell = await connect(host, http)
    await shell.next_json("hello")
    with caplog.at_level("INFO", logger="tidalviz.host"):
        for fps in (21, 22, 60, 61, 20):
            await shell.send(perf(fps))
        await asyncio.sleep(0.2)
    lines = [r.getMessage() for r in caplog.records if "fps" in r.getMessage()]
    assert lines == [
        "builtin/bars throttled at 21 fps",
        "builtin/bars running at 60 fps",
        "builtin/bars throttled at 20 fps",
    ]


@pytest.mark.asyncio
async def test_bench_mode_activates_the_key_and_records_perf_and_stats(
    tmp_path: Path, window: FakeWindow, http
):
    h = Host(
        root=tmp_path / "home",
        builtin_dirs=BUILTINS,
        source_id="synthetic:demo",
        window=window,
        bench_key="builtin/orbit",
    )
    await h.start()
    try:
        shell = await connect(h, http)
        hello = await shell.next_json("hello")
        assert hello["active"] == "builtin/orbit"
        for _ in range(4):
            await shell.send({**perf(60), "key": "builtin/orbit"})
        await shell.next_json("stats", timeout=2.5)
        assert h.bench is not None
        report = h.bench.report()
        assert report["key"] == "builtin/orbit" and report["reports"] == 2  # after warm-up
        assert report["rssMbMax"] > 0
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_transparency_is_a_shell_setting_and_borderless_persists(
    host: Host, window: FakeWindow, http
):
    shell = await connect(host, http)
    hello = await shell.next_json("hello")
    assert hello["settings"]["transparent"] is True and hello["settings"]["borderless"] is True
    await shell.send({"type": "settings", "transparent": False})
    await shell.send({"type": "window", "action": "borderless"})
    await asyncio.sleep(0.2)
    assert host.settings.data["transparent"] is False
    assert host.settings.data["borderless"] is False and window.calls == ["borderless"]


@pytest.mark.asyncio
async def test_recovery_never_loops(tmp_path: Path, window: FakeWindow, http):
    h = Host(
        root=tmp_path / "home",
        builtin_dirs=BUILTINS,
        source_id="synthetic:demo",
        window=window,
        hang_after=0.2,
    )
    await h.start()
    try:
        for _ in range(3):  # the reloaded page keeps failing to heartbeat
            shell = await connect(h, http)
            await shell.next_json("hello")
            await asyncio.sleep(0.5)
            await shell.ws.close()
        assert window.calls.count("recover") == 1
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_float_on_top_toggle_persists(host: Host, window: FakeWindow, http):
    shell = await connect(host, http)
    await shell.next_json("hello")
    assert host.settings.data["onTop"] is True
    await shell.send({"type": "window", "action": "floatOnTop"})
    await asyncio.sleep(0.2)
    assert host.settings.data["onTop"] is False and window.calls == ["floatOnTop"]
