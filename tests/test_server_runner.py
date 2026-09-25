"""HostServers: both servers together, wiring, and clean shutdown."""

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiohttp
import pytest
import pytest_asyncio

from tests.test_server_support import FakeRegistry
from tidalviz.server.runner import DEFAULT_WEB_DIR, HostServers
from tidalviz.transport.control import TextSocket


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "shell").mkdir(parents=True)
    (web / "shell" / "index.html").write_text("<!doctype html>")
    (web / "sdk").mkdir()
    (web / "sdk" / "sdk.js").write_text("SDK")
    return web


@pytest.fixture
def registry(tmp_path: Path) -> FakeRegistry:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "main.js").write_text("export default {}")
    entry = {"id": "bars", "name": "Bars", "entry": "main.js", "renderer": "2d"}
    return FakeRegistry(repos={"builtin": repo}, entries={("builtin", "bars"): entry})


class Events:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.counts: list[int] = []
        self.hangs = 0

    def on_message(self, client: TextSocket, msg: dict[str, Any]) -> None:
        self.messages.append(msg)

    def on_hang(self) -> None:
        self.hangs += 1


@pytest_asyncio.fixture
async def servers(
    registry: FakeRegistry, web_dir: Path
) -> AsyncIterator[tuple[HostServers, Events]]:
    ev = Events()
    hs = HostServers(
        registry,
        web_dir=web_dir,
        dev=False,
        on_message=ev.on_message,
        on_client_count=ev.counts.append,
        on_hang=ev.on_hang,
    )
    await hs.start()
    yield hs, ev
    await hs.stop()


async def wait_for(cond: Any, timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        assert loop.time() < deadline, "timed out"
        await asyncio.sleep(0.005)


def port_of(origin: str) -> int:
    return int(origin.rsplit(":", 1)[1])


def test_default_web_dir_is_the_checkout_web_folder() -> None:
    assert DEFAULT_WEB_DIR.name == "web"
    assert (DEFAULT_WEB_DIR / "sdk").is_dir()


@pytest.mark.asyncio
async def test_two_distinct_loopback_origins(servers: tuple[HostServers, Events]) -> None:
    hs, _ = servers
    assert hs.shell_origin.startswith("http://127.0.0.1:")
    assert hs.plugin_origin.startswith("http://127.0.0.1:")
    assert hs.shell_origin != hs.plugin_origin
    assert hs.shell_url == f"{hs.shell_origin}/?token={hs.token}"


@pytest.mark.asyncio
async def test_token_is_random_per_launch(registry: FakeRegistry, web_dir: Path) -> None:
    a = HostServers(registry, web_dir=web_dir)
    b = HostServers(registry, web_dir=web_dir)
    assert a.token != b.token
    assert len(a.token) >= 43  # secrets.token_urlsafe(32)


@pytest.mark.asyncio
async def test_end_to_end(servers: tuple[HostServers, Events]) -> None:
    hs, ev = servers
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{hs.shell_origin}/config.json?token={hs.token}") as r:
            config = await r.json()
        assert config == {"token": hs.token, "pluginOrigin": hs.plugin_origin, "dev": False}
        async with http.get(f"{hs.plugin_origin}/v/builtin/bars/") as r:
            assert r.status == 200
        async with http.ws_connect(
            f"{hs.shell_origin}/ws?token={hs.token}", origin=hs.shell_origin
        ) as ws:
            await wait_for(lambda: ev.counts == [1])
            await ws.send_str('{"type":"heartbeat","t":1}')
            await wait_for(lambda: ev.messages == [{"type": "heartbeat", "t": 1}])
            hs.hub.publish(b"frame")
            assert (await ws.receive(timeout=1)).data == b"frame"
            await hs.control.broadcast_json({"type": "status", "level": "info", "text": "x"})
            assert json.loads((await ws.receive(timeout=1)).data)["type"] == "status"
    await wait_for(lambda: ev.counts == [1, 0])


@pytest.mark.asyncio
async def test_hang_is_reported(registry: FakeRegistry, web_dir: Path) -> None:
    hung = asyncio.Event()
    hs = HostServers(registry, web_dir=web_dir, on_hang=hung.set, hang_after=0.05)
    await hs.start()
    try:
        async with (
            aiohttp.ClientSession() as http,
            http.ws_connect(f"{hs.shell_origin}/ws?token={hs.token}", origin=hs.shell_origin),
        ):
            await asyncio.wait_for(hung.wait(), 2.0)
    finally:
        await hs.stop()


@pytest.mark.asyncio
async def test_stop_closes_clients_and_releases_ports(
    registry: FakeRegistry, web_dir: Path
) -> None:
    hs = HostServers(registry, web_dir=web_dir)
    await hs.start()
    ports = [port_of(hs.shell_origin), port_of(hs.plugin_origin)]
    async with aiohttp.ClientSession() as http:
        ws = await http.ws_connect(f"{hs.shell_origin}/ws?token={hs.token}", origin=hs.shell_origin)
        await wait_for(lambda: hs.control.client_count == 1)
        await asyncio.wait_for(hs.stop(), 3.0)
        msg = await ws.receive(timeout=1)
        assert msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED)
    assert hs.control.client_count == 0
    assert hs.hub.client_count == 0
    for port in ports:
        with pytest.raises(ConnectionRefusedError):
            await asyncio.open_connection("127.0.0.1", port)
        with socket.socket() as s:  # free to listen on again (TIME_WAIT needs SO_REUSEADDR)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
            s.listen()
    await hs.stop()  # idempotent
