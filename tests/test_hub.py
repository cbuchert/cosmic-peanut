"""FrameHub: latest-only fan-out of binary frames to WebSocket clients."""

import asyncio

import pytest

from tidalviz.transport.hub import FrameHub


class FakeWs:
    """A client whose sends complete only when the test releases them."""

    def __init__(self, *, gated: bool = False) -> None:
        self.sent: list[bytes] = []
        self.gate = asyncio.Event()
        if not gated:
            self.gate.set()
        self.in_flight = 0
        self.max_in_flight = 0
        self.closed = False

    async def send_bytes(self, data: bytes) -> None:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await self.gate.wait()
            if self.closed:
                raise ConnectionResetError("closed")
            self.sent.append(data)
        finally:
            self.in_flight -= 1


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_fast_client_gets_every_frame() -> None:
    hub = FrameHub()
    ws = FakeWs()
    hub.add(ws)
    for i in range(5):
        hub.publish(bytes([i]))
        await settle()
    assert ws.sent == [bytes([i]) for i in range(5)]
    assert hub.dropped(ws) == 0
    await hub.close()


@pytest.mark.asyncio
async def test_slow_client_skips_to_the_newest_frame() -> None:
    hub = FrameHub()
    slow = FakeWs(gated=True)
    hub.add(slow)
    hub.publish(b"first")
    await settle()  # the first send is now in flight and blocked
    for i in range(100):
        hub.publish(f"f{i}".encode())
        assert hub.pending(slow) <= 1
    await settle()
    assert slow.max_in_flight == 1
    slow.gate.set()
    await settle()
    assert slow.sent == [b"first", b"f99"]
    assert hub.dropped(slow) == 99
    await hub.close()


@pytest.mark.asyncio
async def test_slow_client_does_not_hold_back_a_fast_one() -> None:
    hub = FrameHub()
    slow, fast = FakeWs(gated=True), FakeWs()
    hub.add(slow)
    hub.add(fast)
    for i in range(10):
        hub.publish(bytes([i]))
        await settle()
    assert len(fast.sent) == 10
    assert slow.sent == []
    assert hub.pending(slow) == 1
    await hub.close()


@pytest.mark.asyncio
async def test_publish_without_clients_is_a_no_op() -> None:
    hub = FrameHub()
    hub.publish(b"x")
    assert hub.client_count == 0
    await hub.close()


@pytest.mark.asyncio
async def test_removed_client_gets_nothing_more() -> None:
    hub = FrameHub()
    ws = FakeWs()
    hub.add(ws)
    hub.publish(b"a")
    await settle()
    await hub.remove(ws)
    hub.publish(b"b")
    await settle()
    assert ws.sent == [b"a"]
    assert hub.client_count == 0
    await hub.close()


@pytest.mark.asyncio
async def test_failed_send_drops_the_client() -> None:
    hub = FrameHub()
    ws = FakeWs()
    ws.closed = True
    hub.add(ws)
    hub.publish(b"a")
    await settle()
    assert hub.client_count == 0
    await hub.close()


@pytest.mark.asyncio
async def test_total_dropped_sums_clients() -> None:
    hub = FrameHub()
    a, b = FakeWs(gated=True), FakeWs(gated=True)
    hub.add(a)
    hub.add(b)
    for i in range(4):
        hub.publish(bytes([i]))
        await settle()
    assert hub.dropped(a) == 2 and hub.dropped(b) == 2
    assert hub.total_dropped == 4
    await hub.close()
