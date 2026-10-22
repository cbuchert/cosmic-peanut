"""Drive the plugin harness with Playwright: screenshot, frame-time stats, flash-limiter check.

Serve the repo root first (python3 -m http.server <port> --bind 127.0.0.1), then:
    uv run python plugins/_harness/run.py --port <port> [--browser webkit] [bars undertow ...]
    uv run python plugins/_harness/run.py --port <port> --shots DIR [--tag after]
        deterministic stills of each visualizer over black and over a light, busy backdrop
        (plus the backdrop alone), for checking transparency; no timing.
    uv run python plugins/_harness/run.py --port <port> --motion [marbling ...]
        background motion (mean |Δ| per frame, 0–255) in silence, a quiet passage and loud music
        after --warm seconds of pouring, with beat response and motion between events.
    uv run python plugins/_harness/run.py --port <port> --edges 60,120 marbling
        edge sharpness (mean mixed-pixel run between two pure colours) of deterministic stills.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

VIZ = {
    "bars": "builtin",
    "undertow": "builtin",
    "orbit": "builtin",
    "pulsar": "builtin",
    "stargate": "builtin",
    "blaze": "builtin",
    "cascade": "builtin",
    "radar": "builtin",
    "tentacube": "builtin",
    "tiedye": "builtin",
    "skull": "builtin",
    "darksun": "builtin",
    "eclipse": "builtin",
    "marbling": "builtin",
    "laminar": "builtin",
    "tetraballs": "builtin",
    "halo": "template",
    "cosmic-peanut": "cosmic-peanut",
}
BACKDROPS = ("black", "light")
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


MOTION_CONDITIONS = (("silence", 0.0), ("quiet", 0.1), ("loud", 1.0))


def motion_summary(s: dict, fps: float) -> dict:
    """Mean motion, beat response (150 ms after strong onsets vs the 150 ms before) and motion on
    frames where the visualizer started no event (when it reports `debug.events`)."""
    m, on, ev = s["motion"][1:], s["onsets"][1:], s["events"][1:]
    win = max(1, round(0.15 * fps))
    after, before = [], []
    for i, o in enumerate(on):
        if o >= 0.8 and i >= win and i + win < len(m):
            after.append(sum(m[i : i + win]) / win)
            before.append(sum(m[i - win : i]) / win)
    quiet = [x for x, e in zip(m, ev, strict=True) if e == 0]
    mean = lambda a: sum(a) / len(a) if a else -1.0  # noqa: E731
    r = {
        "motion": round(mean(m), 4),
        "beats": len(after),
        "beat_after": round(mean(after), 4),
        "beat_before": round(mean(before), 4),
        "beat_response": round(mean(after) / mean(before), 3)
        if before and mean(before) > 0
        else -1,
        "between_frames": f"{len(quiet)}/{len(m)}",
        "between_motion": round(mean(quiet), 4),
    }
    d = s.get("debug") or {}
    if "drops" in d:
        r["debug"] = d
    return r


def motion(
    browser, base: str, vizs: list[str], prefix: str, warm: float, seconds: float, query: str
) -> dict:
    out = {}
    for viz in vizs:
        res = {}
        for name, gain in MOTION_CONDITIONS:
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
            page.goto(
                f"{base}?repo={prefix}{VIZ[viz]}&viz={viz}&audio=music&warm={warm}&gain={gain}&motion=1&{query}"
            )
            page.wait_for_function("window.__ready === true", timeout=20000)
            page.wait_for_function(
                f"window.__stats().now >= {warm + 0.5}", timeout=int(warm * 3000) + 20000
            )
            before = page.evaluate("window.__viz.debug ? {...window.__viz.debug} : null")
            page.evaluate("window.__reset()")
            page.wait_for_timeout(int(seconds * 1000))
            s = page.evaluate("window.__stats()")
            r = motion_summary(s, s["fps"])
            if before and "drops" in before:
                mins = seconds / 60
                r["drops_per_min"] = round((s["debug"]["drops"] - before["drops"]) / mins, 1)
            r["fps"] = round(s["fps"], 1)
            r["errors"] = s["errors"]
            res[name] = r
            print(viz, name, json.dumps(r), flush=True)
            page.close()
        sil, loud = res["silence"]["motion"], res["loud"]["motion"]
        res["loud_over_silence"] = round(loud / sil, 2) if sil > 0 else float("inf")
        out[viz] = res
    return out


def edges(
    browser, base: str, vizs: list[str], prefix: str, at: list[int], query: str, tag: str
) -> dict:
    """Deterministic stills after each of `at` seconds (fixed 60 Hz steps, music) and the mean
    mixed-pixel run between pure colours; colours come from `window.__viz.debug.colors`."""
    out = {}
    for viz in vizs:
        for sec in at:
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
            page.goto(
                f"{base}?repo={prefix}{VIZ[viz]}&viz={viz}&audio=music&still={sec * 60}&edges=1&{query}"
            )
            page.wait_for_function(
                "window.__still === true || window.__errors.length > 0",
                timeout=(sec * 3 + 30) * 1000,
            )
            e = page.evaluate("window.__edgeResult")
            page.screenshot(path=OUT / f"{viz}-edges-{sec}s-{tag}.png")
            out[f"{viz}@{sec}s"] = e
            print(viz, sec, json.dumps(e), page.evaluate("window.__errors"), flush=True)
            page.close()
    return out


def shots(browser, base: str, vizs: list[str], out: Path, tag: str, prefix: str) -> None:
    """Deterministic stills (`still=150`: 2.5 s of fixed 60 Hz steps) over each backdrop."""
    out.mkdir(parents=True, exist_ok=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
    for bg in BACKDROPS:
        page.goto(f"{base}?viz=none&bg={bg}&nocanvas=1")
        page.wait_for_function("window.__ready === true", timeout=20000)
        page.screenshot(path=out / f"backdrop-{bg}.png")
    for viz in vizs:
        for bg in BACKDROPS:
            page.goto(f"{base}?repo={prefix}{VIZ[viz]}&viz={viz}&bg={bg}&still=150")
            page.wait_for_function(
                "window.__still === true || window.__errors.length > 0", timeout=30000
            )
            page.wait_for_timeout(300)
            errors = page.evaluate("window.__errors")
            page.screenshot(path=out / f"{viz}-{bg}-{tag}.png")
            print(viz, bg, tag, errors or "ok", flush=True)
    page.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("viz", nargs="*", default=list(VIZ))
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="webkit", choices=["webkit", "chromium"])
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--rep", type=int, default=10, help="frames per rAF when timing")
    ap.add_argument("--flash", action="store_true", help="also run the reduceFlashing check")
    ap.add_argument("--query", default="", help="extra query string, e.g. p.mirror=true")
    ap.add_argument("--shots", type=Path, help="write backdrop stills here instead of timing")
    ap.add_argument("--tag", default="after", help="file-name tag for --shots")
    ap.add_argument("--prefix", default="", help="plugin folder prefix under /plugins/")
    ap.add_argument("--motion", action="store_true", help="background-motion measurement")
    ap.add_argument("--warm", type=float, default=20, help="seconds of music before measuring")
    ap.add_argument("--edges", help="comma-separated seconds for edge-sharpness stills")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    base = f"http://127.0.0.1:{args.port}/plugins/_harness/index.html"
    results = {}
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        if args.motion or args.edges:
            if args.motion:
                res = motion(
                    browser, base, args.viz, args.prefix, args.warm, args.seconds, args.query
                )
            else:
                at = [int(x) for x in args.edges.split(",")]
                res = edges(browser, base, args.viz, args.prefix, at, args.query, args.tag)
            kind = "motion" if args.motion else "edges"
            (OUT / f"{kind}-{args.tag}.json").write_text(json.dumps(res, indent=2))
            browser.close()
            return
        if args.shots:
            shots(browser, base, args.viz, args.shots, args.tag, args.prefix)
            browser.close()
            return
        for viz in args.viz:
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
            console = []
            page.on(
                "console", lambda m, c=console: m.type in ("error", "warning") and c.append(m.text)
            )
            page.on("pageerror", lambda e, c=console: c.append(str(e)))
            q = f"repo={args.prefix}{VIZ[viz]}&viz={viz}&{args.query}"
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
