"""The shell server: the host UI's origin and the control WebSocket (docs/protocols.md §3–4)."""

import hmac
from pathlib import Path

from aiohttp import web

from tidalviz.server.base import LocalServer, file_response, raw_tail, shell_csp
from tidalviz.transport.control import MAX_MESSAGE_BYTES, ControlChannel
from tidalviz.transport.hub import FrameHub

# Messages over MAX_MESSAGE_BYTES are dropped by the ControlChannel; far larger ones make aiohttp
# close the socket (1009) before buffering them.
WS_MAX_MSG_SIZE = 4 * MAX_MESSAGE_BYTES


def token_matches(given: str | None, token: str) -> bool:
    """Constant-time token comparison."""
    return given is not None and hmac.compare_digest(given.encode(), token.encode())


class ShellServer(LocalServer):
    def __init__(
        self,
        *,
        web_dir: Path,
        token: str,
        plugin_origin: str,
        dev: bool,
        control: ControlChannel,
        hub: FrameHub,
    ) -> None:
        super().__init__()
        self.control = control
        self.hub = hub
        self._shell_dir = web_dir / "shell"
        self._token = token
        self._plugin_origin = plugin_origin
        self._dev = dev
        self.app.router.add_get("/", self._index)
        self.app.router.add_get("/shell/{path:.*}", self._shell_file)
        self.app.router.add_get("/config.json", self._config)
        self.app.router.add_get("/ws", self._ws)

    def add_headers(self, request: web.Request, response: web.StreamResponse) -> None:
        super().add_headers(request, response)
        response.headers["Content-Security-Policy"] = shell_csp(self.origin, self._plugin_origin)

    def _require_token(self, request: web.Request) -> None:
        if not token_matches(request.query.get("token"), self._token):
            raise web.HTTPForbidden()

    async def _index(self, request: web.Request) -> web.Response:
        return await file_response(self._shell_dir, "index.html")

    async def _shell_file(self, request: web.Request) -> web.Response:
        return await file_response(self._shell_dir, raw_tail(request, 1))

    async def _config(self, request: web.Request) -> web.Response:
        self._require_token(request)
        body = {"token": self._token, "pluginOrigin": self._plugin_origin, "dev": self._dev}
        return web.json_response(body, headers={"Cache-Control": "no-store"})

    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        self._require_token(request)
        if request.headers.getall("Origin", []) != [self.origin]:
            raise web.HTTPForbidden()
        ws = web.WebSocketResponse(max_msg_size=WS_MAX_MSG_SIZE)
        await ws.prepare(request)
        self.hub.add(ws)
        try:
            await self.control.serve(ws)
        finally:
            await self.hub.remove(ws)
        return ws
