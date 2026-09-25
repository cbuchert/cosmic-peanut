"""Check the pywebview window features Tidalviz needs on this macOS (frameless, on-top,
fullscreen toggle, min size, js_api window controls). Writes results/window_controls.json.

uv run python -m tools.spike.window_controls
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

import AppKit
import webview
from PyObjCTools import AppHelper

PRESET = "--preset" in sys.argv
OUT = (
    Path(__file__).resolve().parent
    / "results"
    / ("window_controls_preset.json" if PRESET else "window_controls.json")
)
results: dict[str, Any] = {"js": []}
win: webview.Window


def native_state() -> dict[str, Any]:
    box: dict[str, Any] = {}
    ev = threading.Event()

    def read() -> None:
        w = win.native
        m = int(w.styleMask())
        f = w.frame()
        box.update(
            titled=bool(m & AppKit.NSWindowStyleMaskTitled),
            fullSizeContent=bool(m & AppKit.NSWindowStyleMaskFullSizeContentView),
            fullscreen=bool(m & AppKit.NSWindowStyleMaskFullScreen),
            level=int(w.level()),
            floating=int(w.level()) > AppKit.NSNormalWindowLevel,
            minSize=[w.minSize().width, w.minSize().height],
            frame=[f.size.width, f.size.height],
            closeButtonHidden=bool(w.standardWindowButton_(AppKit.NSWindowCloseButton).isHidden()),
            key=bool(w.isKeyWindow()),
        )
        ev.set()

    AppHelper.callAfter(read)
    ev.wait(2)
    return box


class Api:
    """Exactly the kind of surface the product exposes: window controls only."""

    def fullscreen(self) -> dict[str, Any]:
        win.toggle_fullscreen()
        return {"ok": True}

    def float_on_top(self, on: bool) -> dict[str, Any]:
        win.on_top = bool(on)
        return {"ok": True, "on_top": win.on_top}

    def ping(self, t: float) -> float:
        return t

    def report(self, data: Any) -> None:
        results["js"].append(data)


HTML = """<!doctype html><body style="background:#123;color:#fff;font:14px sans-serif">
<div class="pywebview-drag-region" style="height:40px;background:#246">drag region</div>
<script>
window.addEventListener('pywebviewready', async () => {
  const api = window.pywebview.api;
  const rtts = [];
  for (let i = 0; i < 50; i++) { const t = performance.now(); await api.ping(t); rtts.push(performance.now() - t); }
  rtts.sort((a, b) => a - b);
  await api.report({ kind: 'jsapi-rtt', p50: rtts[25], p95: rtts[47], max: rtts[49], methods: Object.keys(api) });
  await api.report({ kind: 'page', inner: [innerWidth, innerHeight], dpr: devicePixelRatio, ua: navigator.userAgent });
});
</script>"""


def driver() -> None:
    if PRESET:
        # Workaround candidate: allow fullscreen up front so the first toggle isn't lost.
        AppHelper.callAfter(
            lambda: win.native.setCollectionBehavior_(
                AppKit.NSWindowCollectionBehaviorFullScreenPrimary
            )
        )
    time.sleep(2.5)
    results["initial"] = native_state()
    win.on_top = False
    time.sleep(0.3)
    results["after_on_top_false"] = native_state()
    win.on_top = True
    time.sleep(0.3)
    results["after_on_top_true"] = native_state()
    win.resize(200, 150)  # below min size
    time.sleep(0.5)
    results["after_resize_below_min"] = native_state()
    for label, top in (("ontop", True), ("normal", False)):
        win.on_top = top
        time.sleep(0.3)
        win.evaluate_js("pywebview.api.fullscreen()")  # the js_api path, as the shell would call it
        time.sleep(2.5)  # fullscreen animation
        results[f"{label}_after_js_fullscreen_on"] = native_state()
        win.evaluate_js("pywebview.api.fullscreen()")
        time.sleep(2.5)
        results[f"{label}_after_js_fullscreen_off"] = native_state()
    win.destroy()


def main() -> None:
    global win
    win = webview.create_window(
        "controls",
        html=HTML,
        js_api=Api(),
        frameless=True,
        easy_drag=False,
        on_top=True,
        width=960,
        height=540,
        min_size=(640, 360),
        background_color="#000000",
    )
    webview.start(driver)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(results, indent=1, default=str))
    print(json.dumps(results, indent=1, default=str))


if __name__ == "__main__":
    main()
