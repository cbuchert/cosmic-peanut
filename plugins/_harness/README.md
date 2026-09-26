# Plugin harness (dev only, not shipped)

A throwaway fake SDK for developing and benchmarking the reference visualizers before the real SDK
and host exist. `index.html` + `harness.js` build a `ctx` per `web/sdk/tidalviz.d.ts` (2d, webgl2,
or three via the vendored `web/vendor/three` behind the same import map the host uses), feed
`synth.js` audio (120 BPM kick, off-beat hats, drifting bands; `strobe=1` for 10 Hz hits) and call
`frame` on rAF while recording per-frame plugin time.

```sh
python3 -m http.server 8765 --bind 127.0.0.1          # from the repo root (in tmux)
open "http://127.0.0.1:8765/plugins/_harness/index.html?repo=builtin&viz=undertow"
uv run python plugins/_harness/run.py --port 8765 --flash   # all four, WebKit
```

Query params: `repo`, `viz`, `reduce=0|1`, `strobe=1`, `rep=N` (run `frame` N times per rAF —
WebKit clamps `performance.now()` to 1 ms, so divide a longer span; raising N until fps drops also
bounds GPU time), `finish=1`, `lum=1` (record mean luminance), `p.<param>=value`, `bg=light` (a
bright, busy backdrop behind the transparent canvas; default black like the shell), `nocanvas=1`,
`still=N` (seeded `Math.random`, fixed 60 Hz steps, stop after N frames: deterministic stills).
Contexts use the SDK's options (`alpha: true, premultipliedAlpha: true`, three clear alpha 0).

`run.py` writes screenshots and `results-<browser>.json` to `out/` (git-ignored). For each
visualizer it measures p50/p99 frame time, resizes, flips every param, disposes, and with `--flash`
counts flashes/s of mean frame luminance under a 10 Hz strobe with reduceFlashing off and on.
Headless Chromium falls back to software GL here; use WebKit numbers.

`run.py --shots DIR [--tag after] [--prefix path/]` writes deterministic stills of each visualizer
over black and over the light backdrop (plus the backdrop alone) to check transparency; `--prefix`
points at another plugin tree under `/plugins/`, e.g. an older commit extracted with `git archive`.
