"""Loopback delivery of stereo-sized frames at the analysis rate, publisher on its own thread."""

import asyncio
import struct
import threading
import time
from pathlib import Path

import aiohttp
import pytest

from tests.test_server_support import FakeRegistry
from tidalviz.server.runner import HostServers

pytestmark = pytest.mark.perf  # wall-clock sensitive; non-blocking in CI

FRAME_BYTES = 10_592  # stereo frame v1
RATE_HZ = 48_000 / 512  # ~93.75
SECONDS = 2.0


@pytest.mark.asyncio
async def test_latest_only_delivery_is_fast_on_loopback(tmp_path: Path) -> None:
    hs = HostServers(FakeRegistry(), web_dir=tmp_path)
    await hs.start()
    loop = asyncio.get_running_loop()
    latencies: list[float] = []
    received: set[int] = set()
    total = int(SECONDS * RATE_HZ)
    connected = threading.Event()

    def analysis_thread() -> None:
        connected.wait(5)
        payload = bytearray(FRAME_BYTES)
        start = time.perf_counter()
        for i in range(total):
            target = start + i / RATE_HZ
            while (delay := target - time.perf_counter()) > 0:
                time.sleep(min(delay, 0.002))
            struct.pack_into("<Id", payload, 0, i, time.perf_counter())
            loop.call_soon_threadsafe(hs.hub.publish, bytes(payload))

    try:
        async with (
            aiohttp.ClientSession() as http,
            http.ws_connect(f"{hs.shell_origin}/ws?token={hs.token}", origin=hs.shell_origin) as ws,
        ):
            while hs.hub.client_count == 0:
                await asyncio.sleep(0.001)
            publisher = threading.Thread(target=analysis_thread)
            publisher.start()
            connected.set()
            deadline = loop.time() + SECONDS + 2
            while len(received) < total and loop.time() < deadline:
                try:
                    msg = await ws.receive(timeout=0.5)
                except TimeoutError:
                    break
                if msg.type != aiohttp.WSMsgType.BINARY:
                    continue
                now = time.perf_counter()
                i, sent = struct.unpack_from("<Id", msg.data, 0)
                assert len(msg.data) == FRAME_BYTES
                received.add(i)
                latencies.append((now - sent) * 1000)
            publisher.join()
    finally:
        await hs.stop()

    latencies.sort()
    p50 = latencies[len(latencies) // 2]
    p95 = latencies[int(len(latencies) * 0.95)]
    delivered = len(received) / total
    print(
        f"\nloopback frames: {len(received)}/{total} delivered ({delivered:.1%}), "
        f"dropped {hs.hub.total_dropped}, latency p50 {p50:.3f} ms, p95 {p95:.3f} ms, "
        f"max {latencies[-1]:.3f} ms"
    )
    assert delivered >= 0.95
    assert p95 < 5.0
