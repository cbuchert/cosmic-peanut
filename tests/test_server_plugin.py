"""The plugin server: routes, headers, MIME types, path safety, Host checks."""

import os
import re
from collections.abc import AsyncIterator, Mapping
from pathlib import Path

import aiohttp
import pytest
import pytest_asyncio

from tests.test_server_support import FakeRegistry, raw_request
from tidalviz.server.plugin_server import PluginServer

ENTRY = {"id": "bars", "name": "Bars", "entry": "main.js", "renderer": "2d"}


@pytest.fixture
def registry(tmp_path: Path) -> FakeRegistry:
    repo = tmp_path / "repo"
    (repo / "shaders").mkdir(parents=True)
    (repo / "main.js").write_text("export default {}")
    (repo / "shaders" / "a.frag").write_text("void main(){}")
    (repo / "sub").mkdir()
    devrepo = tmp_path / "devrepo"
    devrepo.mkdir()
    (devrepo / "main.js").write_text("// dev")
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    os.symlink(tmp_path / "secret.txt", repo / "escape.txt")
    reg = FakeRegistry(
        repos={"builtin": repo, "dev1": devrepo},
        entries={("builtin", "bars"): ENTRY, ("dev1", "bars"): ENTRY},
        dev={"dev1"},
    )
    return reg


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "sdk").mkdir(parents=True)
    (web / "sdk" / "sdk.js").write_text("export function boot(){}")
    (web / "vendor" / "three" / "addons").mkdir(parents=True)
    (web / "vendor" / "three" / "three.module.js").write_text("export const REVISION = 1")
    return web


@pytest_asyncio.fixture
async def server(registry: FakeRegistry, web_dir: Path) -> AsyncIterator[PluginServer]:
    srv = PluginServer(registry, web_dir=web_dir)
    await srv.start()
    yield srv
    await srv.stop()


@pytest_asyncio.fixture
async def http(server: PluginServer) -> AsyncIterator[aiohttp.ClientSession]:
    async with aiohttp.ClientSession(base_url=server.origin) as session:
        yield session


def assert_plugin_headers(headers: Mapping[str, str], origin: str) -> None:
    h = {k.lower(): v for k, v in headers.items()}
    csp = h["content-security-policy"]
    assert csp.startswith("default-src 'none'; ")
    assert f"script-src {origin} " in csp
    assert "'wasm-unsafe-eval'" in csp
    assert "unsafe-eval'" not in csp.replace("'wasm-unsafe-eval'", "")
    assert f"connect-src {origin} data: blob:" in csp
    assert h["access-control-allow-origin"] == "*"
    assert h["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_binds_loopback_on_a_random_port(server: PluginServer) -> None:
    assert server.port > 0
    assert server.origin == f"http://127.0.0.1:{server.port}"


@pytest.mark.asyncio
async def test_csp_matches_the_contract(http: aiohttp.ClientSession, server: PluginServer) -> None:
    async with http.get("/r/builtin/main.js") as r:
        p = server.origin
        assert r.headers["Content-Security-Policy"] == (
            f"default-src 'none'; script-src {p} 'wasm-unsafe-eval' blob: data:; "
            f"img-src {p} data: blob:; media-src {p} data: blob:; font-src {p} data:; "
            f"connect-src {p} data: blob:; style-src {p} 'unsafe-inline'; worker-src {p} blob:"
        )


@pytest.mark.asyncio
async def test_bootstrap_page(http: aiohttp.ClientSession, server: PluginServer) -> None:
    async with http.get("/v/builtin/bars/") as r:
        assert r.status == 200
        assert r.content_type == "text/html"
        body = await r.text()
        assert_plugin_headers(r.headers, server.origin)
        m = re.search(r"'nonce-([A-Za-z0-9_-]+)'", r.headers["Content-Security-Policy"])
        assert m is not None
        assert f'nonce="{m.group(1)}"' in body
        assert '"entry":"/r/builtin/main.js"' in body
        assert "Cache-Control" not in r.headers or "no-store" not in r.headers["Cache-Control"]


@pytest.mark.asyncio
async def test_bootstrap_nonce_is_fresh_per_response(http: aiohttp.ClientSession) -> None:
    csps: list[str] = []
    for _ in range(2):
        async with http.get("/v/builtin/bars/") as r:
            csps.append(r.headers["Content-Security-Policy"])
    assert csps[0] != csps[1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/v/builtin/nope/", "/v/nope/bars/", "/v/builtin/bars", "/nothing", "/r/nope/main.js"]
)
async def test_unknown_routes_404_with_headers(
    http: aiohttp.ClientSession, server: PluginServer, path: str
) -> None:
    async with http.get(path) as r:
        assert r.status == 404
        assert_plugin_headers(r.headers, server.origin)


@pytest.mark.asyncio
async def test_repo_file(http: aiohttp.ClientSession, server: PluginServer) -> None:
    async with http.get("/r/builtin/main.js") as r:
        assert r.status == 200
        assert r.content_type == "text/javascript"
        assert await r.text() == "export default {}"
        assert_plugin_headers(r.headers, server.origin)
        assert "no-store" not in r.headers.get("Cache-Control", "")


@pytest.mark.asyncio
async def test_dev_repo_is_not_cached(http: aiohttp.ClientSession) -> None:
    for path in ("/r/dev1/main.js", "/v/dev1/bars/"):
        async with http.get(path) as r:
            assert r.status == 200
            assert r.headers["Cache-Control"] == "no-store"


@pytest.mark.asyncio
async def test_sdk_and_three(http: aiohttp.ClientSession) -> None:
    async with http.get("/sdk/sdk.js") as r:
        assert r.status == 200
        assert await r.text() == "export function boot(){}"
    async with http.get("/lib/three/three.module.js") as r:
        assert r.status == 200
        assert r.content_type == "text/javascript"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [
        "/r/builtin/../devrepo/main.js",
        "/r/builtin/%2e%2e/secret.txt",
        "/r/builtin/%2E%2E%2Fsecret.txt",
        "/r/builtin/sub%2f..%2f..%2fsecret.txt",
        "/r/builtin//etc/passwd",
        "/r/builtin/%2fetc%2fpasswd",
        "/r/builtin/..%5csecret.txt",
        "/r/builtin/main.js%00",
        "/r/builtin/escape.txt",
        "/r/builtin/sub",
        "/r/builtin/sub/",
        "/r/builtin/",
        "/sdk/../repo/main.js",
        "/sdk/%2e%2e/vendor/three/three.module.js",
        "/lib/three/../../sdk/sdk.js",
        "/lib/three/addons/",
        "/r/%2e%2e/secret.txt",
    ],
)
async def test_traversal_is_404(server: PluginServer, target: str) -> None:
    r = await raw_request(server.port, target, host=f"127.0.0.1:{server.port}")
    assert r.status == 404
    assert b"SECRET" not in r.body
    assert_plugin_headers(r.headers, server.origin)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host",
    ["localhost:{port}", "127.0.0.1", "evil.example:{port}", "127.0.0.1:1", "[::1]:{port}", ""],
)
async def test_bad_host_is_421_with_headers(server: PluginServer, host: str) -> None:
    r = await raw_request(server.port, "/r/builtin/main.js", host=host.format(port=server.port))
    assert r.status == 421
    assert r.body != b"export default {}"
    assert_plugin_headers(r.headers, server.origin)


@pytest.mark.asyncio
async def test_missing_host_is_421(server: PluginServer) -> None:
    r = await raw_request(server.port, "/r/builtin/main.js", host=None, version="1.0")
    assert r.status == 421


@pytest.mark.asyncio
async def test_exact_host_is_accepted_raw(server: PluginServer) -> None:
    r = await raw_request(server.port, "/r/builtin/main.js", host=f"127.0.0.1:{server.port}")
    assert r.status == 200
    assert r.body == b"export default {}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "ctype"),
    [
        ("a.js", "text/javascript"),
        ("a.mjs", "text/javascript"),
        ("a.wasm", "application/wasm"),
        ("a.json", "application/json"),
        ("a.glsl", "text/plain"),
        ("a.frag", "text/plain"),
        ("a.vert", "text/plain"),
        ("a.wgsl", "text/plain"),
        ("a.css", "text/css"),
        ("a.png", "image/png"),
        ("a.jpg", "image/jpeg"),
        ("a.webp", "image/webp"),
        ("a.svg", "image/svg+xml"),
        ("a.woff2", "font/woff2"),
        ("a.ttf", "font/ttf"),
        ("a.mp3", "audio/mpeg"),
        ("a.bin", "application/octet-stream"),
        ("a.unknownext", "application/octet-stream"),
    ],
)
async def test_mime_types(
    http: aiohttp.ClientSession, registry: FakeRegistry, name: str, ctype: str
) -> None:
    (registry.repos["builtin"] / name).write_bytes(b"\x00data")
    async with http.get(f"/r/builtin/{name}") as r:
        assert r.status == 200
        assert r.content_type == ctype


@pytest.mark.asyncio
async def test_post_is_rejected_with_headers(
    http: aiohttp.ClientSession, server: PluginServer
) -> None:
    async with http.post("/r/builtin/main.js") as r:
        assert r.status == 405
        assert_plugin_headers(r.headers, server.origin)
