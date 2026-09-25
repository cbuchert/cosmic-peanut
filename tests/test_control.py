"""ControlChannel: client tracking, parsing + dispatch, heartbeat watchdog."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from tidalviz.transport.control import MAX_MESSAGE_BYTES, ControlChannel, TextSocket

WsTestClient = TestClient[web.Request, web.Application]


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class FakeClient:
    def __init__(self, *, broken: bool = False) -> None:
        self.sent: list[str] = []
        self.broken = broken
        self.closed = False

    async def send_str(self, data: str) -> None:
        if self.broken:
            raise ConnectionResetError("gone")
        self.sent.append(data)

    async def close(self) -> bool:
        self.closed = True
        return True


class Recorder:
    def __init__(self) -> None:
        self.messages: list[tuple[TextSocket, dict[str, Any]]] = []
        self.counts: list[int] = []
        self.hangs = 0

    def on_message(self, client: TextSocket, msg: dict[str, Any]) -> None:
        self.messages.append((client, msg))

    def on_client_count(self, n: int) -> None:
        self.counts.append(n)

    def on_hang(self) -> None:
        self.hangs += 1


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def channel(rec: Recorder, clock: FakeClock) -> ControlChannel:
    return ControlChannel(
        rec.on_message, on_client_count=rec.on_client_count, on_hang=rec.on_hang, clock=clock
    )


# --- parsing and dispatch -------------------------------------------------------------------


def test_valid_message_is_dispatched(channel: ControlChannel, rec: Recorder) -> None:
    c = FakeClient()
    channel.handle_text(c, '{"type":"select","key":"builtin/bars"}')
    assert rec.messages == [(c, {"type": "select", "key": "builtin/bars"})]


@pytest.mark.parametrize(
    "text",
    [
        '{"type":"select","key":5}',
        '{"type":"select"}',
        '{"key":"x"}',
        "[1,2]",
        '"select"',
        "not json",
        '{"type":"heartbeat","t":NaN}',
        '{"type":"heartbeat","t":Infinity}',
    ],
)
def test_invalid_messages_are_logged_and_dropped(
    channel: ControlChannel, rec: Recorder, caplog: pytest.LogCaptureFixture, text: str
) -> None:
    with caplog.at_level(logging.WARNING, logger="tidalviz.transport.control"):
        channel.handle_text(FakeClient(), text)
    assert rec.messages == []
    assert caplog.records


def test_unknown_type_is_ignored_quietly(
    channel: ControlChannel, rec: Recorder, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="tidalviz.transport.control"):
        channel.handle_text(FakeClient(), '{"type":"fromTheFuture","x":1}')
    assert rec.messages == []
    assert not caplog.records


def test_oversized_message_is_dropped(channel: ControlChannel, rec: Recorder) -> None:
    pad = "x" * MAX_MESSAGE_BYTES
    channel.handle_text(FakeClient(), json.dumps({"type": "select", "key": pad}))
    assert rec.messages == []


def test_oversized_counts_utf8_bytes(channel: ControlChannel, rec: Recorder) -> None:
    pad = "é" * (MAX_MESSAGE_BYTES // 2)  # fewer chars than the limit, more bytes
    channel.handle_text(
        FakeClient(), json.dumps({"type": "select", "key": pad}, ensure_ascii=False)
    )
    assert rec.messages == []


def test_message_at_the_limit_is_accepted(channel: ControlChannel, rec: Recorder) -> None:
    head = '{"type":"select","key":"'
    text = head + "x" * (MAX_MESSAGE_BYTES - len(head) - 2) + '"}'
    assert len(text) == MAX_MESSAGE_BYTES
    channel.handle_text(FakeClient(), text)
    assert len(rec.messages) == 1


def test_handler_exceptions_never_escape(caplog: pytest.LogCaptureFixture) -> None:
    def boom(client: TextSocket, msg: dict[str, Any]) -> None:
        raise RuntimeError("handler bug")

    channel = ControlChannel(boom)
    with caplog.at_level(logging.ERROR, logger="tidalviz.transport.control"):
        channel.handle_text(FakeClient(), '{"type":"select","key":"a/b"}')
    assert "handler bug" in caplog.text


@pytest.mark.asyncio
async def test_async_handler_is_scheduled_and_errors_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[str] = []

    async def handler(client: TextSocket, msg: dict[str, Any]) -> None:
        await asyncio.sleep(0)
        seen.append(msg["type"])
        if msg["type"] == "enable":
            raise RuntimeError("async bug")

    channel = ControlChannel(handler)
    with caplog.at_level(logging.ERROR, logger="tidalviz.transport.control"):
        channel.handle_text(FakeClient(), '{"type":"select","key":"a/b"}')
        channel.handle_text(FakeClient(), '{"type":"enable","key":"a/b"}')
        await channel.close()
    assert seen == ["select", "enable"]
    assert "async bug" in caplog.text


# --- clients and sending --------------------------------------------------------------------


def test_client_count_callbacks(channel: ControlChannel, rec: Recorder) -> None:
    a, b = FakeClient(), FakeClient()
    channel.connect(a)
    channel.connect(b)
    channel.disconnect(a)
    channel.disconnect(a)  # idempotent
    channel.disconnect(b)
    assert rec.counts == [1, 2, 1, 0]
    assert channel.client_count == 0


@pytest.mark.asyncio
async def test_send_and_broadcast(channel: ControlChannel) -> None:
    a, b, broken = FakeClient(), FakeClient(), FakeClient(broken=True)
    for c in (a, b, broken):
        channel.connect(c)
    assert await channel.send_json(a, {"type": "status", "level": "info", "text": "hi"})
    assert not await channel.send_json(broken, {"type": "status"})
    await channel.broadcast_json({"type": "reload", "key": "a/b"})
    assert [json.loads(s) for s in a.sent] == [
        {"type": "status", "level": "info", "text": "hi"},
        {"type": "reload", "key": "a/b"},
    ]
    assert [json.loads(s) for s in b.sent] == [{"type": "reload", "key": "a/b"}]


# --- heartbeat watchdog ---------------------------------------------------------------------


def beat(channel: ControlChannel, client: FakeClient, t: float = 0) -> None:
    channel.handle_text(client, json.dumps({"type": "heartbeat", "t": t}))


def test_no_hang_without_clients(channel: ControlChannel, rec: Recorder, clock: FakeClock) -> None:
    clock.now += 60
    channel.check_watchdog()
    assert rec.hangs == 0


def test_hang_fires_once_after_two_seconds(
    channel: ControlChannel, rec: Recorder, clock: FakeClock
) -> None:
    channel.connect(FakeClient())
    clock.now += 1.99
    channel.check_watchdog()
    assert rec.hangs == 0
    clock.now += 0.01
    channel.check_watchdog()
    assert rec.hangs == 1
    clock.now += 10
    channel.check_watchdog()
    assert rec.hangs == 1


def test_heartbeats_keep_it_alive_and_rearm(
    channel: ControlChannel, rec: Recorder, clock: FakeClock
) -> None:
    c = FakeClient()
    channel.connect(c)
    for _ in range(10):
        clock.now += 0.5
        beat(channel, c)
        channel.check_watchdog()
    assert rec.hangs == 0
    clock.now += 2.0
    channel.check_watchdog()
    assert rec.hangs == 1
    beat(channel, c)  # re-armed
    clock.now += 2.0
    channel.check_watchdog()
    assert rec.hangs == 2


def test_last_client_leaving_disarms(
    channel: ControlChannel, rec: Recorder, clock: FakeClock
) -> None:
    c = FakeClient()
    channel.connect(c)
    channel.disconnect(c)
    clock.now += 5
    channel.check_watchdog()
    assert rec.hangs == 0


def test_invalid_heartbeat_does_not_count(
    channel: ControlChannel, rec: Recorder, clock: FakeClock
) -> None:
    c = FakeClient()
    channel.connect(c)
    clock.now += 1.5
    channel.handle_text(c, '{"type":"heartbeat","t":"x"}')
    clock.now += 0.5
    channel.check_watchdog()
    assert rec.hangs == 1


def test_hang_callback_errors_are_contained(clock: FakeClock) -> None:
    def bad() -> None:
        raise RuntimeError("x")

    channel = ControlChannel(lambda c, m: None, on_hang=bad, clock=clock)
    channel.connect(FakeClient())
    clock.now += 3
    channel.check_watchdog()  # does not raise


@pytest.mark.asyncio
async def test_watchdog_task_runs_on_the_real_clock() -> None:
    hung = asyncio.Event()
    channel = ControlChannel(lambda c, m: None, on_hang=hung.set, hang_after=0.05)
    channel.start(watchdog_interval=0.01)
    channel.connect(FakeClient())
    await asyncio.wait_for(hung.wait(), 1.0)
    await channel.close()


# --- over a real WebSocket ------------------------------------------------------------------


@pytest_asyncio.fixture
async def ws_client(channel: ControlChannel) -> AsyncIterator[WsTestClient]:
    async def handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=4 * MAX_MESSAGE_BYTES)
        await ws.prepare(request)
        await channel.serve(ws)
        return ws

    app = web.Application()
    app.router.add_get("/ws", handler)
    async with TestClient(TestServer(app)) as client:
        yield client


async def wait_for(cond: Callable[[], bool], timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        assert loop.time() < deadline, "timed out"
        await asyncio.sleep(0.005)


@pytest.mark.asyncio
async def test_serve_dispatches_text_ignores_binary_and_oversize(
    ws_client: WsTestClient, rec: Recorder
) -> None:
    ws = await ws_client.ws_connect("/ws")
    await wait_for(lambda: rec.counts == [1])
    await ws.send_bytes(b"\x00\x01binary")
    await ws.send_str(json.dumps({"type": "select", "key": "x" * MAX_MESSAGE_BYTES}))
    await ws.send_str('{"type":"select","key":"a/b"}')
    await wait_for(lambda: len(rec.messages) == 1)
    assert rec.messages[0][1] == {"type": "select", "key": "a/b"}
    assert not ws.closed
    await ws.close()
    await wait_for(lambda: rec.counts == [1, 0])


@pytest.mark.asyncio
async def test_serve_replies_reach_the_client(
    ws_client: WsTestClient, channel: ControlChannel, rec: Recorder
) -> None:
    ws = await ws_client.ws_connect("/ws")
    await wait_for(lambda: rec.counts == [1])
    await channel.broadcast_json({"type": "reload", "key": "a/b"})
    msg = await ws.receive(timeout=1)
    assert msg.type == aiohttp.WSMsgType.TEXT
    assert json.loads(msg.data) == {"type": "reload", "key": "a/b"}
    await ws.close()


@pytest.mark.asyncio
async def test_close_disconnects_clients(
    ws_client: WsTestClient, channel: ControlChannel, rec: Recorder
) -> None:
    ws = await ws_client.ws_connect("/ws")
    await wait_for(lambda: rec.counts == [1])
    await channel.close()
    msg = await ws.receive(timeout=1)
    assert msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED)
    await wait_for(lambda: rec.counts == [1, 0])


def test_on_connect_gets_each_new_client_once(clock: FakeClock) -> None:
    seen: list[object] = []
    channel = ControlChannel(lambda c, m: None, on_connect=seen.append, clock=clock)
    a, b = FakeClient(), FakeClient()
    channel.connect(a)
    channel.connect(a)
    channel.connect(b)
    assert seen == [a, b]
