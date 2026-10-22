"""Drive the plugin harness with Playwright: screenshot, frame-time stats, flash-limiter check.

Serve the repo root first (python3 -m http.server <port> --bind 127.0.0.1), then:
    uv run python plugins/_harness/run.py --port <port> [--browser webkit] [bars undertow ...]
    uv run python plugins/_harness/run.py --port <port> --shots DIR [--tag after]
        deterministic stills of each visualizer over black and over a light, busy backdrop
        (plus the backdrop alone), for checking transparency; no timing.
    uv run python plugins/_harness/run.py --port <port> --motion [--mask 0.9] skull
        background motion: mean |frame-to-frame luminance change| outside the centre circle in
        silence, a quiet passage and loud music, the beat response, and per-pixel black/white
        alternation (Hz, p95) with reduceFlashing on and off. Deterministic (still mode).
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


MOTION_SCENES = {
    # name: (query, reduceFlashing)
    "silence": ("audio=music&level=0", 1),
    "quiet": ("audio=music&level=0.2", 1),
    "loud": ("audio=music", 1),
    "loud_reduce0": ("audio=music", 0),
}
BGM_FRAMES = 60 + 300  # 1 s warm-up, then 5 s measured (fixed 60 Hz steps)
BEAT_WINDOW = 9  # frames: 150 ms at 60 Hz


def beat_response(motion: list[float], onsets: list[float], strong: float = 0.8) -> dict:
    """Mean motion in the 150 ms after each strong onset vs the 150 ms before it."""
    after, before = [], []
    for i, s in enumerate(onsets):
        if s >= strong and i >= BEAT_WINDOW and i + BEAT_WINDOW <= len(motion):
            after += motion[i : i + BEAT_WINDOW]
            before += motion[i - BEAT_WINDOW : i]
    a = sum(after) / max(1, len(after))
    b = sum(before) / max(1, len(before))
    return {"after": round(a, 5), "before": round(b, 5), "ratio": round(a / max(b, 1e-9), 3)}


def motion(browser, base: str, viz: str, prefix: str, mask: float, query: str) -> dict:
    page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=2)
    out: dict = {}
    for name, (q, reduce) in MOTION_SCENES.items():
        url = (
            f"{base}?repo={prefix}{VIZ[viz]}&viz={viz}&{q}&reduce={reduce}"
            f"&still={BGM_FRAMES}&bgm={mask}&{query}"
        )
        page.goto(url)
        page.wait_for_function(
            "window.__still === true || window.__errors.length > 0", timeout=180000
        )
        s = page.evaluate("window.__stats()")
        b = s["bgm"]
        m = b["motion"]
        out[name] = {
            "motion": round(sum(m) / len(m), 5),
            "beat": beat_response(m, b["onsets"]),
            "alt_hz_p95": b["altHzP95"],
            "alt_hz_p99": b["altHzP99"],
            "alt_hz_max": b["altHzMax"],
            "errors": s["errors"],
        }
        print(viz, name, json.dumps(out[name]), flush=True)
    sil = max(out["silence"]["motion"], 1e-9)
    out["loud_over_silence"] = round(out["loud"]["motion"] / sil, 3)
    out["quiet_over_silence"] = round(out["quiet"]["motion"] / sil, 3)
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
    ap.add_argument("--motion", action="store_true", help="measure background motion instead")
    ap.add_argument("--mask", type=float, default=0.9, help="--motion: centre circle to skip")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    base = f"http://127.0.0.1:{args.port}/plugins/_harness/index.html"
    results = {}
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        if args.motion:
            res = {
                v: motion(browser, base, v, args.prefix, args.mask, args.query) for v in args.viz
            }
            browser.close()
            (OUT / f"motion-{args.tag}.json").write_text(json.dumps(res, indent=2))
            print(json.dumps({v: {k: r[k] for k in r if "over" in k} for v, r in res.items()}))
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
