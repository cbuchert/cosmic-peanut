"""The shell server: static shell, config.json, control WebSocket auth, Host checks."""

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiohttp
import pytest
import pytest_asyncio

from tests.test_server_support import raw_request
from tidalviz.server.shell_server import ShellServer
from tidalviz.transport.control import ControlChannel, TextSocket
from tidalviz.transport.hub import FrameHub

TOKEN = "t0ken-for-tests"
PLUGIN_ORIGIN = "http://127.0.0.1:1234"


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "shell").mkdir(parents=True)
    (web / "shell" / "index.html").write_text("<!doctype html><title>shell</title>")
    (web / "shell" / "app.js").write_text("console.log(1)")
    (web / "sdk").mkdir()
    (web / "sdk" / "sdk.js").write_text("SDK")
    return web


class Inbox:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.counts: list[int] = []

    def on_message(self, client: TextSocket, msg: dict[str, Any]) -> None:
        self.messages.append(msg)


@pytest.fixture
def inbox() -> Inbox:
    return Inbox()


@pytest_asyncio.fixture
async def server(web_dir: Path, inbox: Inbox) -> AsyncIterator[ShellServer]:
    control = ControlChannel(inbox.on_message, on_client_count=inbox.counts.append)
    srv = ShellServer(
        web_dir=web_dir,
        token=TOKEN,
        plugin_origin=PLUGIN_ORIGIN,
        dev=True,
        control=control,
        hub=FrameHub(),
    )
    await srv.start()
    yield srv
    await srv.stop()
    await control.close()


@pytest_asyncio.fixture
async def http(server: ShellServer) -> AsyncIterator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession(base_url=server.origin) as session:
        yield session


def expected_csp(server: ShellServer) -> str:
    return (
        f"default-src 'self'; img-src 'self' {PLUGIN_ORIGIN} data:; frame-src {PLUGIN_ORIGIN}; "
        f"connect-src 'self' ws://127.0.0.1:{server.port}; style-src 'self' 'unsafe-inline'"
    )


def assert_shell_headers(headers: Any, server: ShellServer) -> None:
    h = {k.lower(): v for k, v in headers.items()}
    assert h["content-security-policy"] == expected_csp(server)
    assert h["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in h


@pytest.mark.asyncio
async def test_index(http: aiohttp.ClientSession, server: ShellServer) -> None:
    async with http.get(f"/?token={TOKEN}") as r:
        assert r.status == 200
        assert r.content_type == "text/html"
        assert "<title>shell</title>" in await r.text()
        assert_shell_headers(r.headers, server)


@pytest.mark.asyncio
async def test_shell_files(http: aiohttp.ClientSession, server: ShellServer) -> None:
    async with http.get("/shell/app.js") as r:
        assert r.status == 200
        assert r.content_type == "text/javascript"
        assert_shell_headers(r.headers, server)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    ["/shell/../sdk/sdk.js", "/shell/%2e%2e/sdk/sdk.js", "/shell/", "/shell/nope.js", "/x"],
)
async def test_shell_404s_with_headers(server: ShellServer, target: str) -> None:
    r = await raw_request(server.port, target, host=f"127.0.0.1:{server.port}")
    assert r.status == 404
    assert b"SDK" not in r.body
    assert_shell_headers(r.headers, server)


@pytest.mark.asyncio
async def test_config_json(http: aiohttp.ClientSession) -> None:
    async with http.get("/config.json", params={"token": TOKEN}) as r:
        assert r.status == 200
        assert r.content_type == "application/json"
        assert r.headers["Cache-Control"] == "no-store"
        assert await r.json() == {"token": TOKEN, "pluginOrigin": PLUGIN_ORIGIN, "dev": True}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query", ["", "?token=", "?token=wrong", f"?token={TOKEN}x", "?token=%C3%A9"]
)
async def test_config_json_rejects_bad_token(server: ShellServer, query: str) -> None:
    r = await raw_request(server.port, f"/config.json{query}", host=f"127.0.0.1:{server.port}")
    assert r.status == 403
    assert TOKEN.encode() not in r.body
    assert_shell_headers(r.headers, server)


@pytest.mark.asyncio
@pytest.mark.parametrize("host", ["localhost:{port}", "127.0.0.1", "attacker.test:{port}"])
async def test_bad_host_is_421(server: ShellServer, host: str) -> None:
    r = await raw_request(
        server.port, f"/config.json?token={TOKEN}", host=host.format(port=server.port)
    )
    assert r.status == 421
    assert TOKEN.encode() not in r.body
    assert_shell_headers(r.headers, server)


# --- control WebSocket ----------------------------------------------------------------------


async def wait_for(cond: Any, timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        assert loop.time() < deadline, "timed out"
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_ws_carries_control_and_frames(
    http: aiohttp.ClientSession, server: ShellServer, inbox: Inbox
) -> None:
    async with http.ws_connect(f"/ws?token={TOKEN}", origin=server.origin) as ws:
        await wait_for(lambda: inbox.counts == [1])
        await ws.send_str('{"type":"select","key":"builtin/bars"}')
        await wait_for(lambda: len(inbox.messages) == 1)
        server.hub.publish(b"FRAME")
        msg = await ws.receive(timeout=1)
        assert msg.type == aiohttp.WSMsgType.BINARY and msg.data == b"FRAME"
        await server.control.broadcast_json({"type": "reload", "key": "builtin/bars"})
        msg = await ws.receive(timeout=1)
        assert json.loads(msg.data) == {"type": "reload", "key": "builtin/bars"}
    await wait_for(lambda: inbox.counts == [1, 0])
    await wait_for(lambda: server.hub.client_count == 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("query", "origin"),
    [
        (f"?token={TOKEN}", None),
        (f"?token={TOKEN}", PLUGIN_ORIGIN),
        (f"?token={TOKEN}", "null"),
        (f"?token={TOKEN}", "http://localhost:{port}"),
        (f"?token={TOKEN}", "https://127.0.0.1:{port}"),
        ("", "{origin}"),
        ("?token=nope", "{origin}"),
    ],
)
async def test_ws_rejects_bad_token_or_origin(
    http: aiohttp.ClientSession,
    server: ShellServer,
    inbox: Inbox,
    query: str,
    origin: str | None,
) -> None:
    headers: dict[str, str] = {}
    if origin is not None:
        headers["Origin"] = origin.format(port=server.port, origin=server.origin)
    with pytest.raises(aiohttp.WSServerHandshakeError) as err:
        await http.ws_connect(f"/ws{query}", headers=headers)
    assert err.value.status == 403
    assert inbox.counts == []


@pytest.mark.asyncio
async def test_ws_with_bad_host_is_421(server: ShellServer) -> None:
    async with aiohttp.ClientSession() as session:
        with pytest.raises(aiohttp.WSServerHandshakeError) as err:
            await session.ws_connect(
                f"{server.origin}/ws?token={TOKEN}",
                origin=server.origin,
                headers={"Host": f"localhost:{server.port}"},
            )
    assert err.value.status == 421


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["/shell/dev/mock_host.py", "/shell/app.test.js"])
async def test_shell_dev_and_test_files_are_not_served(
    http: aiohttp.ClientSession, web_dir: Path, target: str
) -> None:
    (web_dir / "shell" / "dev").mkdir()
    (web_dir / "shell" / "dev" / "mock_host.py").write_text("dev only")
    (web_dir / "shell" / "app.test.js").write_text("test only")
    async with http.get(target) as r:
        assert r.status == 404
