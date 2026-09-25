"""Spike servers: shell (port A) + plugin (port B) + frame-pumping WebSocket.

Throwaway M1 spike code (not product code). Runs its own asyncio loop in a
background thread so pywebview can own the main thread.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
from aiohttp import WSMsgType, web

STATIC = Path(__file__).resolve().parent / "static"
FRAME_BYTES = 10_592
FRAME_HZ = 48_000 / 512  # 93.75


def make_frame(index: int, rng: np.random.Generator) -> bytearray:
    """A §1-shaped stereo frame (10,592 B). Offset 16 carries time.time() (wall clock)."""
    buf = bytearray(FRAME_BYTES)
    struct.pack_into("<IHHIf", buf, 0, 0x315A5654, 1, 0b100, index, 48000.0)
    struct.pack_into("<HHHH", buf, 24, 64, 1024, 512, 16)
    body = rng.random((FRAME_BYTES - 32) // 4, dtype=np.float32)
    buf[32:] = body.tobytes()
    return buf


def stamp(buf: bytearray) -> float:
    t = time.time()
    struct.pack_into("<d", buf, 16, t)
    return t


def webkit_procs() -> list[dict[str, Any]]:
    out = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,pcpu=,rss=,comm="], capture_output=True, text=True
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5 and "com.apple.WebKit" in parts[4]:
            rows.append(
                {
                    "pid": int(parts[0]),
                    "ppid": int(parts[1]),
                    "cpu": float(parts[2]),
                    "rssMb": int(parts[3]) // 1024,
                    "comm": parts[4].rsplit("/", 1)[-1],
                }
            )
    return rows


class Spike:
    """Holds the run config and everything Python records."""

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.loop: asyncio.AbstractEventLoop | None = None
        self.shell_port = 0
        self.plugin_port = 0
        self.sent: dict[int, float] = {}  # frame index -> time.time() (s) at send
        self.send_late_ms: list[float] = []  # scheduler lateness
        self.heartbeats: list[tuple[float, dict[str, Any]]] = []
        self.events: list[tuple[float, str, Any]] = []
        self.result: dict[str, Any] | None = None
        self.done = threading.Event()
        self.ready = threading.Event()
        self.on_iframe_ready: Any = None  # callable, set by the runner
        self.t_iframe_ready: float | None = None
        self.ws: web.WebSocketResponse | None = None
        self.t_start = time.time()
        self.procs_before = {p["pid"] for p in webkit_procs()}

    def log(self, kind: str, data: Any = None) -> None:
        self.events.append((time.time() - self.t_start, kind, data))

    # ---------- plugin server ----------
    def plugin_csp(self, inline_hashes: list[str], port: int) -> str:
        p = f"http://{self.cfg.get('plugin_host', '127.0.0.1')}:{port}"
        extra = " ".join(f"'sha256-{h}'" for h in inline_hashes)
        return (
            f"default-src 'none'; script-src {p} 'wasm-unsafe-eval' blob: data: {extra}; "
            f"img-src {p} data: blob:; media-src {p} data: blob:; font-src {p} data:; "
            f"connect-src {p} data: blob:; style-src 'unsafe-inline'; worker-src {p} blob:"
        ).replace("  ", " ")

    async def plugin_page(self, req: web.Request) -> web.Response:
        mode = req.query.get("csp", self.cfg["csp"])  # strict | hash
        cfg = json.dumps(
            {"hang": self.cfg["hang"], "mode": mode, "probeOnly": req.query.get("probeOnly") == "1"}
        ).replace("<", "\\u003c")
        importmap = '{"imports":{"dep":"/lib/dep.js"}}'
        module = f'import {{ boot }} from "/sdk/sdk.js"; boot({cfg});'
        hashes = [
            base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
            for s in (importmap, module)
        ]
        html = (
            '<!doctype html><meta charset="utf-8">'
            "<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}"
            "canvas{display:block;width:100vw;height:100vh}</style>"
            '<script src="/sdk/probe.js"></script>'
            f'<script type="importmap">{importmap}</script>'
            f'<script type="module">{module}</script>'
        )
        csp = self.plugin_csp(hashes if mode == "hash" else [], req.url.port or 0)
        return web.Response(
            text=html,
            content_type="text/html",
            headers={"Content-Security-Policy": csp, "Access-Control-Allow-Origin": "*"},
        )

    async def plugin_static(self, req: web.Request) -> web.StreamResponse:
        path = (STATIC / "plugin" / req.match_info["path"]).resolve()
        if not path.is_relative_to(STATIC / "plugin") or not path.is_file():
            raise web.HTTPNotFound()
        self.log("plugin-fetch", {"path": req.path, "origin": req.headers.get("Origin")})
        return web.FileResponse(
            path,
            headers={
                "Content-Security-Policy": self.plugin_csp([], req.url.port or 0),
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                "Content-Type": "text/javascript",
            },
        )

    # ---------- shell server ----------
    def shell_csp(self) -> str:
        p = f"http://{self.cfg.get('plugin_host', '127.0.0.1')}:{self.plugin_port}"
        return (
            f"default-src 'self'; img-src 'self' {p} data:; frame-src 'self' {p}; "
            f"connect-src 'self' ws://127.0.0.1:{self.shell_port}; "
            "style-src 'self' 'unsafe-inline'"
        )

    async def shell_index(self, req: web.Request) -> web.Response:
        html = (STATIC / "shell" / "index.html").read_text()
        return web.Response(
            text=html,
            content_type="text/html",
            headers={"Content-Security-Policy": self.shell_csp()},
        )

    async def shell_static(self, req: web.Request) -> web.StreamResponse:
        path = (STATIC / "shell" / req.match_info["path"]).resolve()
        if not path.is_relative_to(STATIC / "shell") or not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})

    async def config(self, req: web.Request) -> web.Response:
        return web.json_response(
            {
                "pluginUrl": f"http://{self.cfg.get('plugin_host', '127.0.0.1')}:{self.shell_port if self.cfg.get('iframe') == 'same' else self.plugin_port}/v/spike/?csp={self.cfg['csp']}",
                "sandbox": self.cfg.get("sandbox", "allow-scripts"),
                "strictUrl": f"http://127.0.0.1:{self.plugin_port}/v/spike/?csp=strict",
                "probeStrict": self.cfg.get("probe_strict", False),
                "duration": self.cfg["duration"],
                "hang": self.cfg["hang"],
            }
        )

    async def ws_handler(self, req: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024)
        await ws.prepare(req)
        self.ws = ws
        self.log("ws-open", {"origin": req.headers.get("Origin")})
        pump: asyncio.Task[None] | None = None
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            now = time.time()
            m = json.loads(msg.data)
            t = m.get("type")
            if t == "ping":
                await ws.send_str(
                    json.dumps({"type": "pong", "t0": m["t0"], "ts": time.time() * 1000})
                )
            elif t == "start" and pump is None:
                pump = asyncio.create_task(self.pump(ws))
            elif t == "heartbeat":
                self.heartbeats.append((now, m))
            elif t == "iframe:ready":
                self.t_iframe_ready = now
                self.t_first_ready = getattr(self, "t_first_ready", None) or now
                self.log(t, m)
                if self.on_iframe_ready:
                    self.on_iframe_ready()
            elif t == "results":
                self.result = m
                self.done.set()
            else:
                self.log(t or "?", m)
        if pump:
            pump.cancel()
        return ws

    async def pump(self, ws: web.WebSocketResponse) -> None:
        rng = np.random.default_rng(1)
        frames = [make_frame(0, rng) for _ in range(8)]
        period = 1 / FRAME_HZ
        t0 = time.perf_counter()
        i = 0
        while not ws.closed:
            target = t0 + i * period
            delay = target - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
            self.send_late_ms.append((time.perf_counter() - target) * 1000)
            buf = frames[i % 8]
            struct.pack_into("<I", buf, 8, i)
            self.sent[i] = stamp(buf)
            await ws.send_bytes(bytes(buf))
            i += 1

    async def proc_sampler(self) -> None:
        # Sample WebKit helper processes spawned during the run (new PIDs only).
        while True:
            await asyncio.sleep(1.0)
            procs = [
                p
                for p in await asyncio.to_thread(webkit_procs)
                if p["pid"] not in self.procs_before
            ]
            self.log("procs", procs)

    def run(self) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._start())
        self.ready.set()
        self.loop.run_forever()

    async def _start(self) -> None:
        plugin = web.Application()
        plugin.router.add_get("/v/spike/", self.plugin_page)
        plugin.router.add_get("/{path:(sdk|lib)/.+}", self.plugin_static)
        shell = web.Application()
        # Same-origin comparison: the plugin routes are also reachable on the shell port.
        shell.router.add_get("/v/spike/", self.plugin_page)
        shell.router.add_get("/{path:(sdk|lib)/.+}", self.plugin_static)
        shell.router.add_get("/", self.shell_index)
        shell.router.add_get("/shell/{path:.+}", self.shell_static)
        shell.router.add_get("/config.json", self.config)
        shell.router.add_get("/ws", self.ws_handler)
        for app, attr in ((plugin, "plugin_port"), (shell, "shell_port")):
            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            setattr(self, attr, site._server.sockets[0].getsockname()[1])  # type: ignore[union-attr]
        self.loop.create_task(self.proc_sampler())  # type: ignore[union-attr]

    def start_thread(self) -> None:
        threading.Thread(target=self.run, daemon=True).start()
        self.ready.wait(5)

    def request_dump(self) -> None:
        async def _send() -> None:
            if self.ws and not self.ws.closed:
                await self.ws.send_str(json.dumps({"type": "dump"}))

        assert self.loop
        asyncio.run_coroutine_threadsafe(_send(), self.loop)

    @property
    def shell_url(self) -> str:
        return f"http://127.0.0.1:{self.shell_port}/"
