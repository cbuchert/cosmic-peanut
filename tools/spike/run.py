"""Run the WS -> shell -> sandboxed iframe spike and write a JSON summary.

uv run python -m tools.spike.run --name base              # pywebview / WKWebView, 1280x720 pt
uv run python -m tools.spike.run --name hang --hang       # iframe busy-loops after 3 s
uv run python -m tools.spike.run --name occl --minimize   # minimize 5-9 s, hide 11-14 s
uv run python -m tools.spike.run --name pw --browser playwright
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from tools.spike.server import Spike

OUT = Path(__file__).resolve().parent / "results"


def pct(
    xs: list[float] | np.ndarray, ps: tuple[int, ...] = (50, 95, 99)
) -> dict[str, float] | None:
    a = np.asarray(xs, dtype=float)
    if a.size == 0:
        return None
    d = {f"p{p}": round(float(np.percentile(a, p)), 3) for p in ps}
    d.update(
        n=int(a.size),
        mean=round(float(a.mean()), 3),
        max=round(float(a.max()), 3),
        min=round(float(a.min()), 3),
    )
    return d


def analyze(sp: Spike) -> dict[str, Any]:
    r = sp.result or {}
    shell, ifr = r.get("shell", {}), r.get("iframe", {})
    rec = ifr.get("rec", {})
    off_s = (shell.get("clock") or {}).get("offset", 0.0)  # py_ms = shell_ms + off_s
    off_i = (shell.get("ifClock") or {}).get("offset", 0.0)  # shell_ms = iframe_ms + off_i
    sent = {i: t * 1000 for i, t in sp.sent.items()}
    # Measure only frames sent >= 1.5 s after the iframe was ready (after the host's NSEvent
    # click, when enabled, has lifted WebKit's cross-origin rAF throttle).
    t_meas = ((sp.t_iframe_ready or sp.t_start) + 1.5) * 1000
    warm = min((i for i, t in sent.items() if t >= t_meas), default=50)
    ws_recv = {int(i): t for i, t in shell.get("wsRecv", []) if i >= warm}
    arrive = {int(i): t for i, t in rec.get("arrive", []) if i >= warm}
    consume = {int(c[0]): (c[1], c[2]) for c in rec.get("consume", []) if c[0] >= warm}

    host_to_shell = [ws_recv[i] + off_s - sent[i] for i in ws_recv if i in sent]
    shell_to_if = [arrive[i] + off_i - ws_recv[i] for i in arrive if i in ws_recv]
    host_to_if = [arrive[i] + off_i + off_s - sent[i] for i in arrive if i in sent]
    host_to_consume = [consume[i][0] + off_i + off_s - sent[i] for i in consume if i in sent]
    arrive_to_consume = [consume[i][0] - arrive[i] for i in consume if i in arrive]

    raf_now = np.asarray(rec.get("rafNow", []), dtype=float)
    host_to_next_raf, arrive_to_next_raf = [], []
    if raf_now.size:
        for i, ta in arrive.items():
            k = int(np.searchsorted(raf_now, ta, side="left"))
            if k < raf_now.size and i in sent:
                arrive_to_next_raf.append(raf_now[k] - ta)
                host_to_next_raf.append(raf_now[k] + off_i + off_s - sent[i])

    def per_second(ts_ms: np.ndarray, off: float) -> list[int]:
        if ts_ms.size == 0:
            return []
        rel = (ts_ms + off) / 1000 - sp.t_start
        return np.bincount(np.floor(rel[rel >= 0]).astype(int)).tolist()

    shell_raf = np.asarray(shell.get("raf", []), dtype=float)
    sm = shell_raf[shell_raf + off_s >= t_meas]
    sd = np.diff(sm) if sm.size > 2 else np.array([])
    raf = np.asarray(rec.get("rafTs", []), dtype=float)
    raf = raf[raf + off_i + off_s >= t_meas]
    dt = np.diff(raf) if raf.size > 2 else np.array([])
    med = float(np.median(dt)) if dt.size else 0.0
    dropped = int(np.sum(np.maximum(np.round(dt / med) - 1, 0))) if med else None
    span_s = float((raf[-1] - raf[0]) / 1000) if raf.size > 2 else None

    hb = [t for t, _ in sp.heartbeats]
    hb_gaps = np.diff(hb) * 1000 if len(hb) > 1 else np.array([])
    hang_at = next((t for t, k, _ in sp.events if k == "iframe:hanging"), None)
    hb_after_hang = None
    if hang_at is not None:
        abs_hang = sp.t_start + hang_at
        after = [(t - abs_hang, m) for t, m in sp.heartbeats if t > abs_hang]
        ts = [abs_hang] + [t for t, _ in after]
        hb_after_hang = {
            "count": len(after),
            "maxGapMs": round(float(np.max(np.diff(ts))) * 1000, 1) if len(ts) > 1 else None,
            "first": after[0][1] if after else None,
            "last": after[-1][1] if after else None,
        }

    if hang_at is None and sp.cfg["hangRequested"] and sp.t_iframe_ready:
        hang_at = (
            sp.t_first_ready + 3 - sp.t_start
        )  # "hanging" msg can't get out if the shell is hung too
        abs_hang = sp.t_start + hang_at
        before = [t for t in hb if t <= abs_hang]
        after = [(t - abs_hang, m) for t, m in sp.heartbeats if t > abs_hang]
        hb_after_hang = {
            "hangAtS": round(hang_at, 2),
            "lastBeforeHangS": round(before[-1] - sp.t_start, 2) if before else None,
            "count": len(after),
            "firstAfterS": round(after[0][0], 2) if after else None,
        }
    procs = [d for t, k, d in sp.events if k == "procs"]
    return {
        "cfg": sp.cfg,
        "clock": {"shellVsPython": shell.get("clock"), "iframeVsShell": shell.get("ifClock")},
        "shellInfo": shell.get("info"),
        "iframeInfo": ifr.get("info"),
        "canvasSizes": rec.get("sizes"),
        "iframeTimeout": ifr.get("timeout", False),
        "bench": shell.get("bench"),
        "latencyMs": {
            "hostSend_to_shellWsRecv": pct(host_to_shell),
            "shellWsRecv_to_iframeRecv": pct(shell_to_if),
            "hostSend_to_iframeRecv": pct(host_to_if),
            "iframeRecv_to_rafConsume": pct(arrive_to_consume),
            "hostSend_to_rafConsume": pct(host_to_consume),
            "iframeRecv_to_nextRaf_allFrames": pct(arrive_to_next_raf),
            "hostSend_to_nextRaf_allFrames": pct(host_to_next_raf),
        },
        "frames": {
            "sent": len(sp.sent),
            "shellRecv": len(shell.get("wsRecv", [])),
            "iframeRecv": len(rec.get("arrive", [])),
            "consumed": rec.get("consumed"),
            "skippedBeforeRaf": rec.get("skipped"),
            "pySendLateMs": pct(sp.send_late_ms),
        },
        "raf": {
            "iframeHz": round(1000 / med, 2) if med else None,
            "iframeFrameMs": pct(dt, (50, 95, 99)),
            "droppedVsMedian": dropped,
            "spanS": span_s,
            "drawCpuMs": pct(rec.get("drawMs", [])),
            "shellRafCount": len(shell.get("raf", [])),
            "shellHz": round(1000 / float(np.median(sd)), 2) if sd.size else None,
            "shellFrameMs": pct(sd),
            "iframeRafPerSecond": per_second(raf_now, off_i + off_s),
            "shellRafPerSecond": per_second(shell_raf, off_s),
        },
        "shellMainThread": {
            "forwardPostMessageMs": pct(shell.get("fwdCost", [])),
            "wholeOnMessageMs": pct(shell.get("handlerCost", [])),
        },
        "heartbeat": {
            "count": len(hb),
            "gapMs": pct(hb_gaps),
            "afterHang": hb_after_hang,
            "timesS": [round(t - sp.t_start, 2) for t in hb],
        },
        "visibility": {"shell": shell.get("vis"), "iframe": rec.get("vis")},
        "probe": shell.get("probe"),
        "events": [
            (round(t, 2), k, d) for t, k, d in sp.events if k not in ("procs", "plugin-fetch")
        ],
        "pluginFetches": [d for t, k, d in sp.events if k == "plugin-fetch"],
        "webkitProcs": {
            "first": procs[0] if procs else None,
            "peakCount": max((len(p) for p in procs), default=0),
            "timeline": procs,
        },
    }


def patch_features(features: dict[str, bool]) -> None:
    """Make pywebview's WKWebViewConfiguration enable/disable WebKit feature flags."""
    import WebKit
    from webview.platforms import cocoa

    real = WebKit

    class Cfg:
        @staticmethod
        def alloc() -> Cfg:
            return Cfg()

        def init(self):
            c = real.WKWebViewConfiguration.alloc().init()
            for f in real.WKPreferences._features():
                if str(f.key()) in features:
                    c.preferences()._setEnabled_forFeature_(features[str(f.key())], f)
            return c

    class Proxy:
        WKWebViewConfiguration = Cfg

        def __getattr__(self, name: str):
            return getattr(real, name)

    cocoa.WebKit = Proxy()


def click_center(win) -> None:
    import Quartz

    x, y = win.x + win.width / 2, win.y + win.height / 2
    for kind in (Quartz.kCGEventLeftMouseDown, Quartz.kCGEventLeftMouseUp):
        ev = Quartz.CGEventCreateMouseEvent(None, kind, (x, y), Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
        time.sleep(0.05)


def ns_click(win, sp: Spike) -> None:
    """Deliver a synthetic NSEvent click straight to the NSWindow (no global cursor move)."""
    import AppKit
    from PyObjCTools import AppHelper

    def go() -> None:
        w = win.native
        wv = w.contentView()
        if not isinstance(
            wv, __import__("WebKit").WKWebView
        ):  # inspector docked => find the WKWebView
            wv = next(v for v in wv.subviews() if isinstance(v, __import__("WebKit").WKWebView))
        b = wv.bounds()
        pt = wv.convertPoint_toView_(AppKit.NSMakePoint(b.size.width / 2, b.size.height / 2), None)
        for kind in (AppKit.NSEventTypeLeftMouseDown, AppKit.NSEventTypeLeftMouseUp):
            ev = AppKit.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
                kind,
                pt,
                0,
                AppKit.NSProcessInfo.processInfo().systemUptime(),
                w.windowNumber(),
                None,
                0,
                1,
                1.0,
            )
            w.sendEvent_(ev)
        sp.log("nsclick-sent", {"isKey": bool(w.isKeyWindow())})

    AppHelper.callAfter(go)


def run_pywebview(sp: Spike, a: argparse.Namespace) -> None:
    import webview

    if a.feature:
        patch_features({k: v == "1" for k, v in (f.split("=") for f in a.feature)})

    win = webview.create_window(
        "tidalviz spike", sp.shell_url, width=a.width, height=a.height, background_color="#000000"
    )
    if a.nsclick:
        sp.on_iframe_ready = lambda: ns_click(win, sp)

    def watchdog() -> None:
        # The PRD's hang detection: 2 s without a heartbeat => recover the web view.
        from PyObjCTools import AppHelper

        while not sp.done.is_set():
            time.sleep(0.1)
            if not sp.heartbeats or time.time() - sp.heartbeats[-1][0] < 2.0:
                continue
            gap = time.time() - sp.heartbeats[-1][0]
            wv = win.native.contentView()
            sp.cfg["hang"] = False  # the reloaded shell must not hang again

            def recover() -> None:
                sp.log(
                    "watchdog-fired",
                    {
                        "gapS": round(gap, 2),
                        "responsive": bool(wv._webProcessIsResponsive()),
                        "mode": a.recover,
                    },
                )
                pid = int(wv._webProcessIdentifier())
                sp.log("webcontent-pid", pid)
                if a.recover == "kill":
                    wv._killWebContentProcess()
                elif a.recover == "killreset":
                    wv._killWebContentProcessAndResetState()
                elif a.recover == "sigkill":
                    import os
                    import signal

                    os.kill(pid, signal.SIGKILL)
                wv.reload()
                sp.log("recover-issued")

            AppHelper.callAfter(recover)
            return

    if a.recover:
        threading.Thread(target=watchdog, daemon=True).start()

    def driver() -> None:
        t0 = time.time()

        def at(s: float) -> None:
            time.sleep(max(0.0, t0 + s - time.time()))

        if a.fullscreen:
            at(1.5)
            win.toggle_fullscreen()
            sp.log("fullscreen-on")
        if a.minimize:
            at(5)
            sp.log("minimize")
            win.minimize()
            at(9)
            sp.log("restore")
            win.restore()
            at(11)
            sp.log("hide")
            win.hide()
            at(14)
            sp.log("show")
            win.show()
            at(15)
            sp.log("cover")
            cover = webview.create_window(
                "cover",
                html="<body style='background:#333'>",
                x=win.x,
                y=win.y,
                width=win.width,
                height=win.height,
            )
            at(18)
            sp.log("uncover")
            cover.destroy()
        if a.click:
            at(4)
            sp.log("click", {"x": win.x, "y": win.y, "w": win.width, "h": win.height})
            click_center(win)
        if a.inspect:
            at(2)
            try:
                wv = win.native.contentView()
                sp.log(
                    "inspectable",
                    {
                        "isInspectable": bool(wv.isInspectable())
                        if hasattr(wv, "isInspectable")
                        else "n/a",
                        "devExtras": bool(
                            wv.configuration().preferences().valueForKey_("developerExtrasEnabled")
                        ),
                    },
                )
            except Exception as e:
                sp.log("inspectable-error", repr(e))
        at(a.duration)
        sp.request_dump()
        sp.done.wait(5)
        win.destroy()

    webview.start(driver, debug=a.debug)


def run_playwright(sp: Spike, a: argparse.Namespace) -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.webkit.launch(headless=not a.headed)
        pg = b.new_page(viewport={"width": a.width, "height": a.height}, device_scale_factor=2)
        pg.goto(sp.shell_url)
        t0 = time.time()
        while time.time() - t0 < a.duration:
            if a.nsclick and sp.t_iframe_ready and not getattr(sp, "_pw_clicked", False):
                pg.mouse.click(a.width / 2, a.height / 2)
                sp._pw_clicked = True
                sp.log("pw-click")
            pg.wait_for_timeout(100)  # keep the sync driver pumping
        sp.request_dump()
        sp.done.wait(5)
        sp.log("pw-version", b.version)
        b.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--duration", type=float, default=15)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--hang", action="store_true")
    ap.add_argument("--csp", default="hash", choices=["hash", "strict"])
    ap.add_argument("--probe-strict", action="store_true")
    ap.add_argument("--minimize", action="store_true")
    ap.add_argument("--fullscreen", action="store_true")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--browser", default="pywebview", choices=["pywebview", "playwright"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--iframe", default="cross", choices=["cross", "same"])
    ap.add_argument("--sandbox", default="allow-scripts")
    ap.add_argument("--feature", action="append", default=[], help="WebKit feature KEY=0|1")
    ap.add_argument(
        "--recover", choices=["reload", "kill", "killreset", "sigkill"], help="hang watchdog action"
    )
    ap.add_argument(
        "--plugin-host", default="127.0.0.1", help="e.g. localhost => a different *site*"
    )
    ap.add_argument(
        "--nsclick", action="store_true", help="NSEvent click into the WKWebView at 4 s"
    )
    ap.add_argument(
        "--click", action="store_true", help="synthesize a click into the iframe at 4 s"
    )
    a = ap.parse_args()
    sp = Spike(
        {
            "duration": a.duration,
            "hang": a.hang,
            "csp": a.csp,
            "probe_strict": a.probe_strict,
            "browser": a.browser,
            "size": [a.width, a.height],
            "minimize": a.minimize,
            "hangRequested": a.hang,
            "plugin_host": a.plugin_host,
            "fullscreen": a.fullscreen,
            "iframe": a.iframe,
            "sandbox": a.sandbox,
            "features": a.feature,
            "click": a.click,
        }
    )
    sp.start_thread()
    (run_playwright if a.browser == "playwright" else run_pywebview)(sp, a)
    summary = analyze(sp)
    OUT.mkdir(exist_ok=True)
    out = OUT / f"{a.name}.json"
    out.write_text(json.dumps(summary, indent=1, default=str))
    lat = summary["latencyMs"]
    print(
        json.dumps(
            {
                "out": str(out),
                "gotResults": sp.result is not None,
                "latency": lat,
                "raf": summary["raf"],
                "shell": summary["shellMainThread"],
                "hb": summary["heartbeat"],
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
