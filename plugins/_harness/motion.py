"""Background motion: how much a visualizer moves in silence, a quiet passage and loud music.

Serve the repo root first (python3 -m http.server <port> --bind 127.0.0.1), then:
    uv run python plugins/_harness/motion.py --port <port> tiedye [--region 0,0,1,1]

Each condition runs deterministically (`still=N`: fixed 1/60 s steps, seeded randomness), so the
numbers do not depend on machine load. After every frame an injected hook draws the canvas into a
small probe and records the mean absolute change per channel (0-1) from the previous frame, over
the region (fractions x0,y0,x1,y1 of the canvas; default the whole frame). The first WARM frames
are skipped and the next WINDOW (5 s) averaged.

Beat response (loud only): mean motion in the 150 ms after each strong onset (onsetStrength >=
0.8, the kicks and snares) over the mean in the 150 ms before it.
"""

import argparse
import json

from playwright.sync_api import sync_playwright
from run import VIZ  # run as a script from this folder

WARM = 120
WINDOW = 300
BEAT_FRAMES = 9  # 150 ms at 60 Hz
CONDITIONS = {
    "silence": "silent=1",
    "quiet": "audio=music&gain=0.05",
    "loud": "audio=music",
}

HOOK = """
(() => {
  const q = new URLSearchParams(location.search);
  const [x0, y0, x1, y1] = (q.get("region") ?? "0,0,1,1").split(",").map(Number);
  const probe = document.createElement("canvas");
  probe.width = 96; probe.height = 54;
  const g = probe.getContext("2d", { willReadFrequently: true });
  let prev = null;
  window.__motion = [];
  window.__onsets = [];
  window.__afterFrame = (canvas, audio) => {
    const sx = x0 * canvas.width, sy = y0 * canvas.height;
    g.clearRect(0, 0, probe.width, probe.height);
    g.drawImage(canvas, sx, sy, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height,
      0, 0, probe.width, probe.height);
    const d = g.getImageData(0, 0, probe.width, probe.height).data;
    let s = 0;
    if (prev) for (let i = 0; i < d.length; i++) if ((i & 3) !== 3) s += Math.abs(d[i] - prev[i]);
    window.__motion.push(prev ? s / ((d.length / 4) * 3 * 255) : 0);
    window.__onsets.push(audio.onset && audio.onsetStrength >= 0.8 ? 1 : 0);
    prev = prev ?? new Uint8ClampedArray(d.length);
    prev.set(d);
  };
})();
"""


def rounded(v):
    if isinstance(v, dict):
        return {k: rounded(x) for k, x in v.items()}
    return round(v, 5) if isinstance(v, float) else v


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def measure(page, url: str) -> tuple[list[float], list[int]]:
    page.goto(url)
    page.wait_for_function("window.__still === true || window.__errors.length > 0", timeout=120000)
    errors = page.evaluate("window.__errors")
    if errors:
        raise RuntimeError(errors)
    return page.evaluate("window.__motion"), page.evaluate("window.__onsets")


def beat_response(motion: list[float], onsets: list[int]) -> dict:
    before, after = [], []
    for i in range(WARM, WARM + WINDOW):
        if onsets[i]:
            before.append(mean(motion[i - BEAT_FRAMES : i]))
            after.append(mean(motion[i : i + BEAT_FRAMES]))
    b, a = mean(before), mean(after)
    return {"beats": len(after), "before": b, "after": a, "ratio": a / b if b else 0.0}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("viz", nargs="+")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="webkit", choices=["webkit", "chromium"])
    ap.add_argument("--region", default="0,0,1,1", help="x0,y0,x1,y1 fractions of the canvas")
    ap.add_argument("--query", default="", help="extra query string, e.g. p.speed=2")
    ap.add_argument("--prefix", default="", help="plugin folder prefix under /plugins/")
    args = ap.parse_args()
    base = f"http://127.0.0.1:{args.port}/plugins/_harness/index.html"
    n = WARM + WINDOW + BEAT_FRAMES
    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch()
        page = browser.new_page(viewport={"width": 960, "height": 540}, device_scale_factor=1)
        page.add_init_script(HOOK)
        for viz in args.viz:
            r: dict = {}
            for name, cq in CONDITIONS.items():
                url = (
                    f"{base}?repo={args.prefix}{VIZ[viz]}&viz={viz}&still={n}&{cq}"
                    f"&region={args.region}&{args.query}"
                )
                motion, onsets = measure(page, url)
                r[name] = mean(motion[WARM : WARM + WINDOW])
                if name == "loud":
                    r["beat"] = beat_response(motion, onsets)
            r["loud_over_silence"] = r["loud"] / r["silence"] if r["silence"] else float("inf")
            r["loud_over_quiet"] = r["loud"] / r["quiet"] if r["quiet"] else float("inf")
            print(viz, json.dumps(rounded(r)), flush=True)
        browser.close()


if __name__ == "__main__":
    main()
