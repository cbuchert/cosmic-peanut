"""Runs the plugin server, the shell server, the frame hub and the control channel together."""

import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any

from tidalviz.server.plugin_server import PluginServer
from tidalviz.server.registry_view import RegistryView
from tidalviz.server.shell_server import ShellServer
from tidalviz.transport.control import HANG_AFTER_S, ControlChannel, OnMessage, TextSocket
from tidalviz.transport.hub import FrameHub

DEFAULT_WEB_DIR = Path(__file__).resolve().parents[3] / "web"


def _ignore(client: TextSocket, msg: dict[str, Any]) -> None:
    pass


class HostServers:
    """Both loopback servers plus the hub and control channel, sharing one per-launch token.

    Create anywhere; call `start()` and `stop()` on the asyncio loop that should own them
    (e.g. ``asyncio.run_coroutine_threadsafe(servers.start(), loop).result()``).
    """

    def __init__(
        self,
        registry: RegistryView,
        *,
        web_dir: Path = DEFAULT_WEB_DIR,
        dev: bool = False,
        on_message: OnMessage = _ignore,
        on_client_count: Callable[[int], None] | None = None,
        on_connect: Callable[[TextSocket], None] | None = None,
        on_hang: Callable[[], None] | None = None,
        hang_after: float = HANG_AFTER_S,
    ) -> None:
        self.token = secrets.token_urlsafe(32)
        self.hub = FrameHub()
        self.control = ControlChannel(
            on_message,
            on_client_count=on_client_count,
            on_connect=on_connect,
            on_hang=on_hang,
            hang_after=hang_after,
        )
        self._web_dir = web_dir
        self._dev = dev
        self.plugin_server = PluginServer(registry, web_dir=web_dir)
        self.shell_server: ShellServer | None = None
        self._watchdog_interval = min(0.25, hang_after / 4)

    @property
    def plugin_origin(self) -> str:
        return self.plugin_server.origin

    @property
    def shell_origin(self) -> str:
        assert self.shell_server is not None, "not started"
        return self.shell_server.origin

    @property
    def shell_url(self) -> str:
        """What the web view opens: ``S/?token=<t>``."""
        return f"{self.shell_origin}/?token={self.token}"

    async def start(self) -> None:
        await self.plugin_server.start()  # the shell's CSP and config need the plugin origin
        self.shell_server = ShellServer(
            web_dir=self._web_dir,
            token=self.token,
            plugin_origin=self.plugin_server.origin,
            dev=self._dev,
            control=self.control,
            hub=self.hub,
        )
        await self.shell_server.start()
        self.control.start(watchdog_interval=self._watchdog_interval)

    async def stop(self) -> None:
        """Close every client, then both listeners. Idempotent."""
        await self.control.close()
        await self.hub.close()
        if self.shell_server is not None:
            await self.shell_server.stop()
        await self.plugin_server.stop()
