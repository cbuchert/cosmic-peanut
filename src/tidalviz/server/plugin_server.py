"""The plugin server: the sandboxed origin plugins load from (docs/protocols.md §3)."""

import secrets
from pathlib import Path

from aiohttp import web

from tidalviz.server.base import LocalServer, file_response, plugin_csp, raw_tail
from tidalviz.server.bootstrap import bootstrap_html
from tidalviz.server.paths import is_dev_only
from tidalviz.server.registry_view import RegistryView

_DEV = web.RequestKey("dev", bool)
_NONCE = web.RequestKey("nonce", str)


class PluginServer(LocalServer):
    def __init__(self, registry: RegistryView, *, web_dir: Path) -> None:
        super().__init__()
        self._registry = registry
        self._sdk_dir = web_dir / "sdk"
        self._three_dir = web_dir / "vendor" / "three"
        self.app.router.add_get("/v/{repo}/{viz}/", self._bootstrap)
        self.app.router.add_get("/r/{repo}/{path:.*}", self._repo_file)
        self.app.router.add_get("/sdk/{path:.*}", self._sdk_file)
        self.app.router.add_get("/lib/three/{path:.*}", self._three_file)

    def add_headers(self, request: web.Request, response: web.StreamResponse) -> None:
        super().add_headers(request, response)
        nonce = request.get(_NONCE)
        response.headers["Content-Security-Policy"] = plugin_csp(self.origin, nonce)
        response.headers["Access-Control-Allow-Origin"] = "*"
        if request.get(_DEV):
            response.headers["Cache-Control"] = "no-store"

    def _mark_dev(self, request: web.Request, repo_key: str) -> None:
        if self._registry.is_dev(repo_key):
            request[_DEV] = True

    async def _bootstrap(self, request: web.Request) -> web.Response:
        repo_key, viz_id = request.match_info["repo"], request.match_info["viz"]
        entry = self._registry.entry(repo_key, viz_id)
        if entry is None:
            raise web.HTTPNotFound()
        self._mark_dev(request, repo_key)
        nonce = secrets.token_urlsafe(18)
        request[_NONCE] = nonce
        html = bootstrap_html(repo_key, viz_id, entry, nonce=nonce)
        return web.Response(text=html, content_type="text/html")

    async def _repo_file(self, request: web.Request) -> web.Response:
        repo_key = request.match_info["repo"]
        base = self._registry.repo_dir(repo_key)
        if base is None:
            raise web.HTTPNotFound()
        self._mark_dev(request, repo_key)
        return await file_response(base, raw_tail(request, 2))

    async def _sdk_file(self, request: web.Request) -> web.Response:
        tail = raw_tail(request, 1)
        if is_dev_only(tail):
            raise web.HTTPNotFound()
        return await file_response(self._sdk_dir, tail)

    async def _three_file(self, request: web.Request) -> web.Response:
        return await file_response(self._three_dir, raw_tail(request, 2))
