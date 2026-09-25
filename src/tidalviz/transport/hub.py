"""Latest-only fan-out of binary frames to WebSocket clients (docs/protocols.md §2)."""

import asyncio
import contextlib
import logging
from typing import Protocol

log = logging.getLogger(__name__)


class BinarySink(Protocol):
    """What the hub needs from a client; `aiohttp.web.WebSocketResponse` satisfies it."""

    async def send_bytes(self, data: bytes) -> None: ...


class _Client:
    __slots__ = ("dropped", "pending", "ready", "sent", "task")

    def __init__(self) -> None:
        self.pending: bytes | None = None
        self.ready = asyncio.Event()
        self.dropped = 0
        self.sent = 0
        self.task: asyncio.Task[None] | None = None


class FrameHub:
    """Lives on the asyncio loop. Each client has at most one send in flight and at most one
    pending frame; publishing while a frame is pending replaces it (counted as dropped).
    """

    def __init__(self) -> None:
        self._clients: dict[BinarySink, _Client] = {}
        self._total_dropped = 0

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def total_dropped(self) -> int:
        """Frames skipped across all clients since the hub was created."""
        return self._total_dropped

    def add(self, ws: BinarySink) -> None:
        if ws in self._clients:
            return
        client = _Client()
        client.task = asyncio.get_running_loop().create_task(self._pump(ws, client))
        self._clients[ws] = client

    async def remove(self, ws: BinarySink) -> None:
        client = self._clients.pop(ws, None)
        if client is not None and client.task is not None:
            client.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await client.task

    def publish(self, data: bytes) -> None:
        """Hand the newest frame to every client. Never blocks, never queues more than one."""
        for client in self._clients.values():
            if client.pending is not None:
                client.dropped += 1
                self._total_dropped += 1
            client.pending = data
            client.ready.set()

    def pending(self, ws: BinarySink) -> int:
        client = self._clients.get(ws)
        return int(client is not None and client.pending is not None)

    def dropped(self, ws: BinarySink) -> int:
        client = self._clients.get(ws)
        return client.dropped if client is not None else 0

    def sent(self, ws: BinarySink) -> int:
        client = self._clients.get(ws)
        return client.sent if client is not None else 0

    async def close(self) -> None:
        for ws in list(self._clients):
            await self.remove(ws)

    async def _pump(self, ws: BinarySink, client: _Client) -> None:
        while True:
            await client.ready.wait()
            client.ready.clear()
            data, client.pending = client.pending, None
            if data is None:
                continue
            try:
                await ws.send_bytes(data)
            except Exception as exc:  # a closed or broken socket: forget the client
                log.debug("frame client dropped: %r", exc)
                if self._clients.get(ws) is client:
                    del self._clients[ws]
                return
            client.sent += 1
