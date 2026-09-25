"""The control WebSocket's message layer: clients, validated dispatch, heartbeat watchdog.

docs/protocols.md §4. Binary host → shell frames go through `FrameHub`; this class handles text.
"""

import asyncio
import contextlib
import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, NoReturn, Protocol

from aiohttp import WSMsgType, web

from tidalviz.transport.control_schema import ShellMessageError, validate_shell_message

log = logging.getLogger(__name__)

MAX_MESSAGE_BYTES = 64 * 1024
HANG_AFTER_S = 2.0


class TextSocket(Protocol):
    """What the channel needs from a client; `aiohttp.web.WebSocketResponse` satisfies it."""

    async def send_str(self, data: str) -> None: ...
    async def close(self) -> bool: ...


OnMessage = Callable[[TextSocket, dict[str, Any]], Awaitable[None] | None]


def _reject_constant(name: str) -> NoReturn:
    raise ValueError(f"non-finite number {name}")


class ControlChannel:
    """Tracks shell clients, validates their messages and dispatches the valid ones.

    ``on_message(client, msg)`` gets every valid known message (heartbeats included); an
    awaitable result is run as a task so a slow handler never stalls the receive loop.
    ``on_client_count(n)`` runs on every connect/disconnect. ``on_hang()`` runs once when a
    client is connected and no valid heartbeat has arrived for ``hang_after`` seconds (the
    clock starts at each connect and each heartbeat; the next heartbeat or connect re-arms it).
    Callback errors are logged, never raised.
    """

    def __init__(
        self,
        on_message: OnMessage,
        *,
        on_client_count: Callable[[int], None] | None = None,
        on_hang: Callable[[], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        hang_after: float = HANG_AFTER_S,
        max_message_bytes: int = MAX_MESSAGE_BYTES,
    ) -> None:
        self._on_message = on_message
        self._on_client_count = on_client_count
        self._on_hang = on_hang
        self._clock = clock
        self._hang_after = hang_after
        self._max_bytes = max_message_bytes
        self._clients: list[TextSocket] = []
        self._last_beat: float | None = None  # None: watchdog disarmed
        self._tasks: set[asyncio.Task[None]] = set()
        self._watchdog: asyncio.Task[None] | None = None

    @property
    def clients(self) -> tuple[TextSocket, ...]:
        return tuple(self._clients)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    # --- lifecycle ------------------------------------------------------------------------

    def start(self, *, watchdog_interval: float = 0.25) -> None:
        """Start the watchdog task on the running loop."""
        if self._watchdog is None:
            self._watchdog = asyncio.get_running_loop().create_task(
                self._watchdog_loop(watchdog_interval)
            )

    async def close(self) -> None:
        """Stop the watchdog, close every client, and finish running handler tasks."""
        if self._watchdog is not None:
            self._watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog
            self._watchdog = None
        for client in list(self._clients):
            with contextlib.suppress(Exception):
                await client.close()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    # --- clients --------------------------------------------------------------------------

    def connect(self, client: TextSocket) -> None:
        if client in self._clients:
            return
        self._clients.append(client)
        self._last_beat = self._clock()
        self._notify_count()

    def disconnect(self, client: TextSocket) -> None:
        if client not in self._clients:
            return
        self._clients.remove(client)
        if not self._clients:
            self._last_beat = None
        self._notify_count()

    async def serve(self, ws: web.WebSocketResponse) -> None:
        """Run one prepared WebSocket's receive loop until it closes."""
        self.connect(ws)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    self.handle_text(ws, msg.data)
                # binary and other inbound messages are ignored
        finally:
            self.disconnect(ws)

    async def send_json(self, client: TextSocket, msg: dict[str, Any]) -> bool:
        """Send one message; False if the client is gone (never raises for a closed socket)."""
        return await self._send(client, json.dumps(msg, separators=(",", ":")))

    async def broadcast_json(self, msg: dict[str, Any]) -> None:
        text = json.dumps(msg, separators=(",", ":"))
        await asyncio.gather(*(self._send(c, text) for c in list(self._clients)))

    async def _send(self, client: TextSocket, text: str) -> bool:
        try:
            await client.send_str(text)
        except Exception as exc:
            log.debug("control send failed: %r", exc)
            return False
        return True

    # --- inbound --------------------------------------------------------------------------

    def handle_text(self, client: TextSocket, data: str) -> None:
        """Parse, validate and dispatch one inbound text message. Never raises."""
        if len(data) > self._max_bytes or len(data.encode("utf-8")) > self._max_bytes:
            log.warning("control: dropped oversized message (%d chars)", len(data))
            return
        try:
            msg = json.loads(data, parse_constant=_reject_constant)
        except ValueError as exc:
            log.warning("control: dropped malformed JSON: %s", exc)
            return
        if not isinstance(msg, dict):
            log.warning("control: dropped non-object message")
            return
        message: dict[str, Any] = msg  # pyright: ignore[reportUnknownVariableType]
        try:
            known = validate_shell_message(message)
        except ShellMessageError as exc:
            log.warning("control: rejected message: %s", exc)
            return
        if not known:
            log.debug("control: ignored unknown type %r", message.get("type"))
            return
        if message["type"] == "heartbeat":
            self._last_beat = self._clock()
        self._dispatch(client, message)

    def _dispatch(self, client: TextSocket, msg: dict[str, Any]) -> None:
        try:
            result = self._on_message(client, msg)
        except Exception:
            log.exception("control: handler failed for %r", msg.get("type"))
            return
        if inspect.isawaitable(result):
            task = asyncio.ensure_future(result)
            self._tasks.add(task)
            task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            log.error("control: async handler failed", exc_info=exc)

    # --- watchdog -------------------------------------------------------------------------

    def check_watchdog(self) -> None:
        """Fire ``on_hang`` if the heartbeat is overdue. Called periodically by `start`."""
        if self._last_beat is None or self._clock() - self._last_beat < self._hang_after:
            return
        self._last_beat = None
        log.warning("control: no heartbeat for %.1f s", self._hang_after)
        if self._on_hang is not None:
            try:
                self._on_hang()
            except Exception:
                log.exception("control: on_hang failed")

    async def _watchdog_loop(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            self.check_watchdog()

    def _notify_count(self) -> None:
        if self._on_client_count is not None:
            try:
                self._on_client_count(len(self._clients))
            except Exception:
                log.exception("control: on_client_count failed")
