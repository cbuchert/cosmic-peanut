"""Shared mechanics of the two loopback servers: binding, Host checks, response headers."""

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

from aiohttp import web

from tidalviz.server.mime import content_type_for
from tidalviz.server.paths import resolve_under

HOST = "127.0.0.1"
Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


def plugin_csp(plugin_origin: str, nonce: str | None = None) -> str:
    p = plugin_origin
    script = f"{p} 'nonce-{nonce}'" if nonce else p
    return (
        f"default-src 'none'; script-src {script} 'wasm-unsafe-eval' blob: data:; "
        f"img-src {p} data: blob:; media-src {p} data: blob:; font-src {p} data:; "
        f"connect-src {p} data: blob:; style-src {p} 'unsafe-inline'; worker-src {p} blob:"
    )


def shell_csp(shell_origin: str, plugin_origin: str) -> str:
    ws = shell_origin.replace("http://", "ws://", 1)
    return (
        f"default-src 'self'; img-src 'self' {plugin_origin} data:; frame-src {plugin_origin}; "
        f"connect-src 'self' {ws}; style-src 'self' 'unsafe-inline'"
    )


class LocalServer:
    """An aiohttp app bound to 127.0.0.1 on a random port.

    Every request whose Host header is not exactly ``127.0.0.1:<port>`` gets 421 (DNS
    rebinding defense), and ``add_headers`` runs on every response, errors included.
    """

    def __init__(self) -> None:
        @web.middleware
        async def host_guard(request: web.Request, handler: Handler) -> web.StreamResponse:
            if request.headers.getall("Host", []) != [f"{HOST}:{self._port}"]:
                raise web.HTTPMisdirectedRequest()
            return await handler(request)

        self.app = web.Application(middlewares=[host_guard])
        self.app.on_response_prepare.append(self._on_prepare)
        self._runner: web.AppRunner | None = None
        self._port = 0

    @property
    def port(self) -> int:
        return self._port

    @property
    def origin(self) -> str:
        return f"http://{HOST}:{self._port}"

    async def start(self) -> None:
        runner = web.AppRunner(self.app, access_log=None, shutdown_timeout=1.0)
        await runner.setup()
        await web.TCPSite(runner, HOST, 0).start()
        self._runner = runner
        self._port = int(runner.addresses[0][1])

    async def stop(self) -> None:
        if self._runner is not None:
            runner, self._runner = self._runner, None
            await runner.cleanup()

    def add_headers(self, request: web.Request, response: web.StreamResponse) -> None:
        response.headers.setdefault("X-Content-Type-Options", "nosniff")

    async def _on_prepare(self, request: web.Request, response: web.StreamResponse) -> None:
        self.add_headers(request, response)


def raw_tail(request: web.Request, prefix_segments: int) -> str:
    """The still-percent-encoded path after the first ``prefix_segments`` segments."""
    parts = request.rel_url.raw_path.split("/", prefix_segments + 1)
    return parts[prefix_segments + 1] if len(parts) > prefix_segments + 1 else ""


async def file_response(base: Path, raw: str) -> web.Response:
    """Serve ``raw`` (percent-encoded, relative) from ``base``, or raise 404."""
    path = resolve_under(base, raw)
    if path is None:
        raise web.HTTPNotFound()
    try:
        body = await asyncio.to_thread(path.read_bytes)
    except OSError:
        raise web.HTTPNotFound() from None
    return web.Response(body=body, headers={"Content-Type": content_type_for(path)})
