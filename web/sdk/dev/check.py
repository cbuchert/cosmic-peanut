"""Dev-only browser check of the SDK in Playwright WebKit (not shipped; see README.md here).

Usage: uv run python web/sdk/dev/check.py http://127.0.0.1:<port>/   (server: serve.py)
Asserts: plugins render (ready), frames are consumed (onsetSeen), perf flows, a throwing plugin
is reported fatal after 3 frames, 2d / webgl2 / three work, visibility pauses; prints SDK overhead.
"""

import json
import statistics
import sys

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"


BENCH = """async () => {
  const { createRuntime } = await import("/sdk/runtime.js");
  const { encodeFrame } = await import("/sdk/dev/encode.js");
  let cb = (_ts) => {};
  const rt = createRuntime({
    port: { postMessage() {} },
    init: { type: "tidalviz:init", quality: "auto", visible: true },
    manifest: { id: "b", name: "b", entry: "x.js", renderer: "2d" },
    base: location.origin + "/r/dev/",
    canvas: { width: 0, height: 0 },
    cssSize: { width: 800, height: 600 },
    loadEntry: async () => ({ default: () => ({ frame() {} }) }),
    createContext: async () => ({ ctx2d: null, gl: null, gpu: null, three: null }),
    raf: (c) => ((cb = c), 1),
    caf() {},
    now: () => performance.now(),
    devicePixelRatio: () => 2,
    fetch: (u) => fetch(u),
  });
  await rt.start();
  const frames = Array.from({ length: 64 }, (_, i) => encodeFrame({ frameIndex: i, stereo: true, onset: i % 8 === 0 }));
  const run = (n, t) => { for (let i = 0; i < n; i++) { rt.handleMessage(frames[i & 63]); cb(t + i * 16.67); } };
  run(2000, 0);
  const N = 200000, t0 = performance.now();
  run(N, 1e6);
  return (performance.now() - t0) / N;
}"""


def msgs(page: Page) -> list[dict]:
    return page.evaluate("window.__msgs")


def of(page: Page, t: str) -> list[dict]:
    return [m for m in msgs(page) if isinstance(m, dict) and m.get("type") == t]


def load(page: Page, viz: str, seconds: float = 3.5) -> None:
    page.goto(f"{BASE}?viz={viz}")
    page.wait_for_timeout(seconds * 1000)


def main() -> None:
    failures: list[str] = []

    def check(cond: bool, what: str) -> None:
        print(("ok   " if cond else "FAIL ") + what)
        if not cond:
            failures.append(what)

    with sync_playwright() as p:
        browser = p.webkit.launch()
        page = browser.new_page()
        page.on(
            "console",
            lambda m: print("  console:", m.text) if m.type in ("error", "warning") else None,
        )

        sdk_ms: list[float] = []
        for viz in ("bars", "glpulse", "cube"):
            load(page, viz)
            perf = of(page, "perf")
            check(len(of(page, "ready")) == 1, f"{viz}: ready once")
            check(len(of(page, "error")) == 0, f"{viz}: no errors {of(page, 'error')[:1]}")
            check(len(perf) >= 2, f"{viz}: perf flows ({len(perf)} reports)")
            check(
                len(of(page, "onsetSeen")) >= 2,
                f"{viz}: frames consumed (onsetSeen {len(of(page, 'onsetSeen'))})",
            )
            if perf:
                last = perf[-1]
                print("     perf:", json.dumps(last))
                # headless WebKit throttles rAF to ~20 fps, so only sanity-check the rate here
                check(last["fps"] >= 15, f"{viz}: fps {last['fps']:.1f}")
                sdk_ms += [r["sdkMsP50"] for r in perf[1:]]

        load(page, "bars", 1.5)
        check(
            any(m["text"].startswith("bars created") for m in of(page, "log")),
            "bars: ctx.log arrives as text",
        )
        page.evaluate('window.__send({type: "visibility", visible: false})')
        page.wait_for_timeout(300)
        n = len(of(page, "perf"))
        page.wait_for_timeout(2200)
        check(len(of(page, "perf")) == n, "visibility:false stops the loop (no perf while hidden)")
        page.evaluate('window.__send({type: "visibility", visible: true})')
        page.wait_for_timeout(2200)
        check(len(of(page, "perf")) > n, "visibility:true resumes")
        page.evaluate('window.__send({type: "dispose"})')
        page.wait_for_timeout(200)
        check(len(of(page, "disposed")) == 1, "dispose acknowledged")

        load(page, "boom", 2)
        errs = of(page, "error")
        check(
            [e["fatal"] for e in errs] == [False, False, True],
            f"boom: fatal after 3 frames {[e['fatal'] for e in errs]}",
        )
        check(
            bool(errs) and errs[-1].get("file") == "src/boom.js" and errs[-1].get("line") == 6,
            f"boom: file/line {errs[-1].get('file') if errs else None}:{errs[-1].get('line') if errs else None}",
        )
        check(len(of(page, "ready")) == 0, "boom: never ready")

        load(page, "gpu", 2)
        ready, errs = of(page, "ready"), of(page, "error")
        check(
            len(ready) == 1 or (errs and errs[-1].get("fallback") == "bars" and errs[-1]["fatal"]),
            f"gpu: renders or reports fallback ({'ready' if ready else errs[-1:]})",
        )

        # Aggregate SDK overhead: the real runtime, a no-op plugin, a new stereo frame every tick.
        page.goto(BASE)
        per_tick = page.evaluate(BENCH)
        print(
            f"SDK overhead (WebKit, aggregate over 200k ticks incl. decode/perf/quality): {per_tick * 1000:.1f} us/frame"
        )
        check(per_tick < 1.0, "SDK overhead < 1 ms per frame")

        browser.close()

    if sdk_ms:
        print(
            f"sdkMsP50 reported live (1 ms timer granularity in WebKit): median {statistics.median(sdk_ms):.3f} ms"
        )
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
