# SDK dev harness (not shipped)

Throwaway tooling for checking the SDK in a real browser without the host. Nothing here is loaded
by the SDK at runtime; packaging should exclude `web/sdk/dev/`.

| File | Role |
| --- | --- |
| `serve.py` | Static server mimicking the plugin server routes (`/sdk/`, `/lib/three/`, `/r/dev/`, generated `/v/dev/<id>/` bootstrap pages), with `Access-Control-Allow-Origin: *` |
| `harness.html`, `harness.js` | Plays the shell: sandboxed iframe, `tidalviz:init` + MessagePort, synthetic stereo frames at ~94 Hz (transferred), records SDK messages in `window.__msgs` |
| `plugins/` | Tiny test visualizers: `bars` (2d), `glpulse` (webgl2), `cube` (three), `gpu` (webgpu → `bars`), `boom` (throws every frame) |
| `check.py` | Playwright WebKit assertions + SDK overhead micro-benchmark |
| `encode.js` | Binary v1 encoder, shared with the vitest suites |

```sh
uv run python web/sdk/dev/serve.py 8765            # prints the URL; open /?viz=bars in a browser
uv run python web/sdk/dev/check.py http://127.0.0.1:8765/
```

Headless WebKit throttles `requestAnimationFrame` to ~20 fps, so fps numbers from `check.py` are
not representative, and WebKit's `performance.now()` has 1 ms granularity in the sandboxed iframe,
so per-frame p50s of sub-millisecond work read 0. `check.py` measures SDK overhead as an aggregate
over 200k ticks instead.
