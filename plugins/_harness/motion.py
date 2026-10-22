"""Background / sun motion of a visualizer over silence, a quiet passage and loud music.

Serve the repo root first (python3 -m http.server <port> --bind 127.0.0.1), then:
    uv run python plugins/_harness/motion.py --port <port> darksun [--prefix path/] [--strip DIR]

Each passage runs `still` frames (fixed 1/60 s steps, deterministic) with `meter=1`, discards a 1 s
warm-up and reports, per zone, the mean absolute frame-to-frame RGB change (0-255) over 5 s, plus
the beat response: mean motion in the 150 ms after each strong onset over the 150 ms before it.
Zones are ordered include/exclude rects (motion.js); ZONES holds the ones per visualizer.
`--strip DIR` also writes a strip of frames across a few beats of the loud passage.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

# 1280 x 720 frame, 0-1 coordinates, y down.
ZONES = {
    "darksun": {
        # Sky and ground, minus the sun's disc and rim (and the arc it may drift on), the inverted
        # range and the beam.
        "bg": "-0.43,0.04,0.57,0.42;-0.24,0.48,0.76,0.82;-0.47,0.48,0.53,1",
        # The sun with its corona and halo.
        "sun": "+0.36,0,0.64,0.48",
    },
}
PASSAGES = {
    "silence": "silent=1",
    "quiet": "audio=music&gain=0.05",
    "loud": "audio=music",
}
WARM = 60
FRAMES = 300
WIN = 9  # 150 ms at 60 Hz


def beat_response(m: list[float], beats: list[int]) -> float:
    """Mean motion over the WIN frames after each beat / the WIN frames before it."""
    after, before = [], []
    for b in beats:
        if b - WIN < 0 or b + WIN >= len(m):
            continue
        after += m[b + 1 : b + 1 + WIN]
        before += m[b - WIN : b]
    if not before:
        return 0.0
    a, z = sum(after) / len(after), sum(before) / len(before)
    return a / z if z > 0 else float("inf") if a > 0 else 1.0


def measure(page, url: str) -> dict:
    page.goto(url)
    page.wait_for_function("window.__still === true || window.__errors.length > 0", timeout=60000)
    s = page.evaluate("window.__stats()")
    if s["errors"]:
        raise RuntimeError(s["errors"])
    out = {}
    beats = [b - WARM for b in s["beats"] if b >= WARM]
    for zone, m in s["motion"].items():
        m = m[WARM:]
        out[zone] = {"mean": round(sum(m) / len(m), 3), "beat": round(beat_response(m, beats), 3)}
    return out


def strip(browser, base: str, q: str, out: Path) -> None:
    """Frames 240-276 (a kick at 240, a snare at 270) side by side."""
    out.mkdir(parents=True, exist_ok=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    names = []
    for f in (236, 241, 244, 248, 254, 262, 272):
        page.goto(f"{base}?{q}&audio=music&still={f}")
        page.wait_for_function("window.__still === true", timeout=60000)
        name = f"frame-{f}.png"
        page.screenshot(path=out / name)
        names.append(name)
    imgs = "".join(f'<img src="{n}" style="width:320px;margin:2px">' for n in names)
    sheet = out / "strip.html"
    sheet.write_text(f"<body style='margin:0;background:#000;display:flex'>{imgs}</body>")
    page.set_viewport_size({"width": 324 * len(names), "height": 184})
    page.goto(sheet.as_uri())
    page.screenshot(path=out / "strip.png")
    page.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("viz", nargs="+")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="webkit", choices=["webkit", "chromium"])
    ap.add_argument("--prefix", default="", help="plugin folder prefix under /plugins/")
    ap.add_argument("--repo", default="builtin")
    ap.add_argument("--query", default="", help="extra query string, e.g. motion=reduce")
    ap.add_argument("--strip", type=Path, help="write a strip of frames across beats here")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}/plugins/_harness/index.html"
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        for viz in args.viz:
            zones = "&".join(
                f"zone.{k}={v}" for k, v in ZONES.get(viz, {"all": "+0,0,1,1"}).items()
            )
            q = f"repo={args.prefix}{args.repo}&viz={viz}&{args.query}"
            r = {}
            for name, a in PASSAGES.items():
                r[name] = measure(page, f"{base}?{q}&{a}&meter=1&{zones}&still={WARM + FRAMES}")
            for zone in r["loud"]:
                for ref in ("silence", "quiet"):
                    lo = r[ref][zone]["mean"]
                    hi = r["loud"][zone]["mean"]
                    r.setdefault(f"loud/{ref}", {})[zone] = round(hi / lo, 2) if lo else None
            print(viz, json.dumps(r), flush=True)
            if args.strip:
                strip(browser, base, q, args.strip)
        browser.close()


if __name__ == "__main__":
    main()
