"""Drive the plugin harness with Playwright: screenshot, frame-time stats, flash-limiter check.

Serve the repo root first (python3 -m http.server <port> --bind 127.0.0.1), then:
    uv run python plugins/_harness/run.py --port <port> [--browser webkit] [bars undertow ...]
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

VIZ = {
    "bars": "builtin",
    "undertow": "builtin",
    "orbit": "builtin",
    "halo": "template",
}
OUT = Path(__file__).resolve().parent / "out"


def flashes_per_second(lum: list[float], fps: float, threshold: float) -> float:
    """Max number of rise-then-fall pairs (each >= threshold) in any 1 s window."""
    starts, rising, lo, hi = [], False, lum[0], lum[0]
    for i, v in enumerate(lum[1:], 1):
        if not rising:
            lo = min(lo, v)
            if v - lo >= threshold:
                starts.append(i / fps)
                rising, hi = True, v
        else:
            hi = max(hi, v)
            if hi - v >= threshold:
                rising, lo = False, v
    best = 0
    for i, s in enumerate(starts):
        best = max(best, sum(1 for t in starts[i:] if t - s < 1))
    return best


def run(page, url: str, seconds: float) -> dict:
    page.goto(url)
    page.wait_for_function("window.__ready === true", timeout=20000)
    page.wait_for_timeout(1000)
    page.evaluate("window.__reset && window.__reset()")
    page.wait_for_timeout(int(seconds * 1000))
    return page.evaluate("window.__stats ? window.__stats() : {errors: window.__errors}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("viz", nargs="*", default=list(VIZ))
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="webkit", choices=["webkit", "chromium"])
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--rep", type=int, default=10, help="frames per rAF when timing")
    ap.add_argument("--flash", action="store_true", help="also run the reduceFlashing check")
    ap.add_argument("--query", default="", help="extra query string, e.g. p.mirror=true")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    base = f"http://127.0.0.1:{args.port}/plugins/_harness/index.html"
    results = {}
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        for viz in args.viz:
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
            console = []
            page.on(
                "console", lambda m, c=console: m.type in ("error", "warning") and c.append(m.text)
            )
            page.on("pageerror", lambda e, c=console: c.append(str(e)))
            q = f"repo={VIZ[viz]}&viz={viz}&{args.query}"
            page.goto(f"{base}?{q}")
            page.wait_for_function("window.__ready === true", timeout=20000)
            page.wait_for_timeout(2500)
            page.screenshot(path=OUT / f"{viz}-{args.browser}.png")
            cpu = run(page, f"{base}?{q}&rep={args.rep}", args.seconds)
            gpu = run(page, f"{base}?{q}&rep={args.rep}&finish=1", args.seconds)
            r = {
                "size": cpu.get("size"),
                "cpu_p50_ms": round(cpu.get("p50", -1), 3),
                "cpu_p99_ms": round(cpu.get("p99", -1), 3),
                "finish_p50_ms": round(gpu.get("p50", -1), 3),
                "finish_p99_ms": round(gpu.get("p99", -1), 3),
                "fps": round(cpu.get("fps", 0), 1),
                "errors": cpu.get("errors", []) + gpu.get("errors", []) + console,
            }
            # Resize, flip every param, then dispose: none of it may throw.
            page.evaluate(
                """async () => {
                  const wait = () => new Promise((r) => setTimeout(r, 150));
                  window.__resize(800, 450); await wait();
                  window.__resize(1280, 720); await wait();
                  for (const [k, v] of Object.entries(window.__ctx.params)) {
                    const next = typeof v === "boolean" ? !v : typeof v === "number" ? v * 0.5
                      : v.startsWith("#") ? "#33ff66" : v;
                    window.__setParam(k, next); await wait();
                  }
                  for (const m of ["rings", "bars", "16", "32"]) { window.__setParam("mode", m); await wait(); }
                  window.__dispose();
                }"""
            )
            r["errors"] += page.evaluate("window.__errors")
            if args.flash:
                for reduce in (0, 1):
                    s = run(page, f"{base}?{q}&strobe=1&lum=1&reduce={reduce}", 4)
                    lum = s["lum"]
                    r[f"flash_reduce{reduce}"] = {
                        "lum_range": [round(min(lum), 3), round(max(lum), 3)],
                        "max_per_s@0.02": flashes_per_second(lum, s["fps"], 0.02),
                        "max_per_s@0.05": flashes_per_second(lum, s["fps"], 0.05),
                    }
            results[viz] = r
            print(viz, json.dumps(r), flush=True)
            page.close()
        browser.close()
    (OUT / f"results-{args.browser}.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
