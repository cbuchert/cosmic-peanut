"""Host CPU budget check (PRD → Performance → Budgets: < 10% of one core, steady state).

Runs a headless Host on the given audio source with a real WebSocket client in a separate
process (so the client's CPU isn't counted), measures the host process's CPU over the window
and prints a per-thread breakdown. Exits 1 if the host is at or over the budget, 2 if the
measurement is invalid (no frames, or mostly silent audio — is music playing?).

    uv run python -m tools.cpu_budget --seconds 60 --source system
"""

import argparse
import asyncio
import ctypes
import json
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
BUILTINS = [REPO / "plugins" / "builtin", REPO / "plugins" / "template"]


@dataclass(frozen=True, slots=True)
class ThreadCpu:
    thread_id: int  # matches threading.Thread.native_id
    name: str  # pthread name ("" when unnamed)
    cpu_s: float  # user + system seconds


class _IdentifierInfo(ctypes.Structure):  # THREAD_IDENTIFIER_INFO
    _fields_ = (
        ("thread_id", ctypes.c_uint64),
        ("thread_handle", ctypes.c_uint64),
        ("dispatch_qaddr", ctypes.c_uint64),
    )


class _ExtendedInfo(ctypes.Structure):  # THREAD_EXTENDED_INFO
    _fields_ = (
        ("user_ns", ctypes.c_uint64),
        ("system_ns", ctypes.c_uint64),
        ("cpu_usage", ctypes.c_int32),
        ("policy", ctypes.c_int32),
        ("run_state", ctypes.c_int32),
        ("flags", ctypes.c_int32),
        ("sleep_time", ctypes.c_int32),
        ("curpri", ctypes.c_int32),
        ("priority", ctypes.c_int32),
        ("maxpriority", ctypes.c_int32),
        ("name", ctypes.c_char * 64),
    )


_THREAD_IDENTIFIER_INFO, _THREAD_EXTENDED_INFO = 4, 5
_libc: Any = None


def thread_cpu() -> dict[int, ThreadCpu]:
    """CPU time of every thread in this process (Python and native), keyed by thread id."""
    global _libc
    if _libc is None:
        _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    libc = _libc
    task = ctypes.c_uint32.in_dll(libc, "mach_task_self_").value
    threads = ctypes.POINTER(ctypes.c_uint32)()
    count = ctypes.c_uint32()
    if libc.task_threads(task, ctypes.byref(threads), ctypes.byref(count)) != 0:
        raise OSError("task_threads failed")
    out: dict[int, ThreadCpu] = {}
    try:
        for i in range(count.value):
            port = threads[i]
            ident, ext = _IdentifierInfo(), _ExtendedInfo()
            n1 = ctypes.c_uint32(ctypes.sizeof(ident) // 4)
            n2 = ctypes.c_uint32(ctypes.sizeof(ext) // 4)
            ok = (
                libc.thread_info(port, _THREAD_IDENTIFIER_INFO, ctypes.byref(ident), ctypes.byref(n1))
                == 0
                and libc.thread_info(port, _THREAD_EXTENDED_INFO, ctypes.byref(ext), ctypes.byref(n2))
                == 0
            )  # fmt: skip
            libc.mach_port_deallocate(task, port)
            if ok:
                out[ident.thread_id] = ThreadCpu(
                    ident.thread_id,
                    ext.name.decode(errors="replace"),
                    (ext.user_ns + ext.system_ns) / 1e9,
                )
    finally:
        addr = ctypes.cast(threads, ctypes.c_void_p).value
        libc.vm_deallocate(task, ctypes.c_size_t(addr or 0), ctypes.c_size_t(4 * count.value))
    return out


# --- client (separate process) ------------------------------------------------------------


async def _client(url: str, origin: str, seconds: float) -> None:
    import aiohttp

    frames = silent = 0
    nbytes = 0
    async with aiohttp.ClientSession() as s, s.ws_connect(url, origin=origin) as ws:
        loop = asyncio.get_running_loop()
        end = loop.time() + seconds
        next_beat = 0.0
        while (now := loop.time()) < end:
            if now >= next_beat:  # like the shell: a heartbeat every 0.5 s
                await ws.send_str(json.dumps({"type": "heartbeat", "t": time.time() * 1000}))
                next_beat = now + 0.5
            try:
                m = await ws.receive(timeout=min(0.5, end - now))
            except TimeoutError:
                continue
            if m.type == aiohttp.WSMsgType.BINARY:
                frames += 1
                nbytes += len(m.data)
                silent += bool(m.data[6] & 2)
            elif m.type != aiohttp.WSMsgType.TEXT:
                break
    print(json.dumps({"frames": frames, "silent": silent, "bytes": nbytes}), flush=True)


# --- host side ------------------------------------------------------------------------------


class _NullWindow:
    def fullscreen(self) -> None: ...
    def float_on_top(self) -> None: ...
    def borderless(self) -> None: ...
    def quit(self) -> None: ...
    def click_plugin(self) -> None: ...
    def recover_webview(self) -> None: ...
    def pick_folder(self) -> str | None:
        return None


async def _measure(source: str, seconds: float, warmup: float) -> dict[str, Any]:
    import psutil

    from tidalviz.host import Host

    root = Path(tempfile.mkdtemp(prefix="tvz-cpu-"))
    host = Host(root=root, builtin_dirs=BUILTINS, source_id=source, window=_NullWindow())
    await host.start()
    client = None
    try:
        url = f"{host.servers.shell_origin.replace('http', 'ws', 1)}/ws?token={host.servers.token}"
        client = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "tools.cpu_budget", "--client", url,
            "--origin", host.servers.shell_origin, "--seconds", str(warmup + seconds + 1.0),
            stdout=asyncio.subprocess.PIPE, cwd=REPO,
        )  # fmt: skip
        await asyncio.sleep(warmup)  # catap start, tempo lock, caches
        proc = psutil.Process()
        c0, t0, w0 = proc.cpu_times(), thread_cpu(), time.monotonic()
        await asyncio.sleep(seconds)
        c1, t1, w1 = proc.cpu_times(), thread_cpu(), time.monotonic()
        names = {t.native_id: t.name for t in threading.enumerate() if t.native_id is not None}
        stats = host.pipeline.stats() if host.pipeline is not None else None
        out, _ = await client.communicate()
        client = None
    finally:
        if client is not None:
            client.kill()
            await client.wait()
        await host.stop()
    wall = w1 - w0
    per_thread = []
    for tid, t in t1.items():
        d = t.cpu_s - (t0[tid].cpu_s if tid in t0 else 0.0)
        per_thread.append((100.0 * d / wall, names.get(tid) or t.name or f"native-{tid}"))
    per_thread.sort(reverse=True)
    lines = out.decode().strip().splitlines()
    return {
        "cpu_pct": 100.0 * ((c1.user + c1.system) - (c0.user + c0.system)) / wall,
        "threads": per_thread,
        "client": json.loads(lines[-1]) if lines else {"frames": 0, "silent": 0, "bytes": 0},
        "stats": stats,
        "wall": wall,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--source", default="system", help="system | app:<pid> | synthetic:<name>")
    ap.add_argument("--warmup", type=float, default=5.0)
    ap.add_argument("--budget", type=float, default=10.0, help="percent of one core")
    ap.add_argument("--client", help=argparse.SUPPRESS)
    ap.add_argument("--origin", help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.client:
        asyncio.run(_client(args.client, args.origin, args.seconds))
        return

    r = asyncio.run(_measure(args.source, args.seconds, args.warmup))
    c, s = r["client"], r["stats"]
    print(f"host CPU {r['cpu_pct']:.1f}% of one core over {r['wall']:.0f} s ({args.source})")
    for pct, name in r["threads"]:
        if pct >= 0.05:
            print(f"  {pct:5.1f}%  {name}")
    print(
        f"client (separate process): {c['frames']} frames, {c['silent']} silent, "
        f"{c['bytes'] / 1e6 / (args.seconds + args.warmup):.1f} MB/s"
    )
    if s is not None:
        print(f"analysis p50 {s.analysis_ms_p50:.3f} ms, p99 {s.analysis_ms_p99:.3f} ms")
    if c["frames"] == 0 or c["silent"] > 0.2 * c["frames"]:
        print("INVALID: no frames or mostly silent audio (is music playing?)")
        sys.exit(2)
    if r["cpu_pct"] >= args.budget:
        print(f"OVER BUDGET: {r['cpu_pct']:.1f}% ≥ {args.budget:g}%")
        sys.exit(1)
    print(f"within budget (< {args.budget:g}%)")


if __name__ == "__main__":
    main()
