# Writing a Tidalviz visualizer

A visualizer is a plain ES module plus a JSON manifest in a git repo (or a local folder). No build
step, no `npm`: what's committed is what runs. The host captures and analyzes audio; your code
just draws. Types for everything below live in [`web/sdk/tidalviz.d.ts`](../web/sdk/tidalviz.d.ts)
— copy it next to your code for editor autocomplete.

## Quick start

```
my-viz/
  tidalviz.json
  src/main.js
  tidalviz.d.ts      # optional, for autocomplete
```

`tidalviz.json`:

```json
{
  "apiVersion": 1,
  "visualizers": [
    {
      "id": "pulse",
      "name": "Pulse",
      "entry": "src/main.js",
      "renderer": "2d",
      "params": [
        { "id": "hue", "type": "number", "label": "Hue", "min": 0, "max": 360, "default": 200 }
      ]
    }
  ]
}
```

`src/main.js`:

```js
// @ts-check
/** @type {import('../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const g = /** @type {CanvasRenderingContext2D} */ (ctx.ctx2d);
  return {
    frame(audio) {
      const { width, height } = ctx.size;
      g.fillStyle = "#000";
      g.fillRect(0, 0, width, height);
      g.fillStyle = `hsl(${ctx.params.hue} 80% 60%)`;
      const r = Math.min(width, height) * 0.2 * (0.5 + audio.bassAtt * 0.5);
      g.beginPath();
      g.arc(width / 2, height / 2, r, 0, Math.PI * 2);
      g.fill();
    },
  };
}
```

Run it with hot reload: `uv run tidalviz --dev path/to/my-viz` (or **Library → Add folder** in the
app). Saving any file reloads the visualizer within ~300 ms and keeps parameter values. Errors show
in an overlay with file and line while the last working version keeps running.

## Manifest (`tidalviz.json`)

Always at the repo root, always a `visualizers` array (one repo can ship several). Validated
against [`manifest.schema.json`](../src/tidalviz/plugins/manifest.schema.json); errors name the
field path and reason.

| Field | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | `1` |
| `visualizers[].id` | yes | `^[a-z0-9-]{1,40}$`, unique in the repo. Global key is `<repo key>/<id>` |
| `visualizers[].name` | yes | Display name (rendered as text) |
| `visualizers[].entry` | yes | Repo-relative path to the ES module |
| `visualizers[].renderer` | yes | `2d`, `webgl2`, `webgpu` or `three` |
| `visualizers[].description`, `author` | no | Shown in the library |
| `visualizers[].thumbnail` | no | Repo-relative image, shown in the library |
| `visualizers[].libs` | no | Host-provided libraries. v1: `["three"]` |
| `visualizers[].fallback` | no | `webgpu` only: `id` of another entry to run when WebGPU is unavailable |
| `visualizers[].params` | no | Controls the host renders for the user (below) |

### Params

| `type` | Extra fields | Value |
| --- | --- | --- |
| `number` | `min`, `max`, `step?`, `default` | number |
| `color` | `default` (`#rrggbb`) | `#rrggbb` string |
| `boolean` | `default` | boolean |
| `select` | `options` (strings), `default` | one of `options` |

Beyond the schema, the host checks: visualizer ids and param ids (per visualizer) are unique;
`number` params have `min < max` and `min <= default <= max`; a `select` default is one of its
`options`; `fallback` appears only on `webgpu` entries and names another, non-`webgpu` entry;
renderer `three` requires `"libs": ["three"]`; `entry` and `thumbnail` exist inside the repo
(symlinks may not point outside it).

Values persist per visualizer and can be reset by the user. Read them from `ctx.params` (always
current); implement `params(changed)` if you need to react to a change (rebuild geometry, etc.).

## Entry module

The default export is a factory, `create(ctx)`, which may be `async` (load shaders, textures). It
returns an object with `frame` and optional hooks:

```js
export default async function create(ctx) {
  const src = await ctx.assets.text("shaders/warp.frag");
  // ...set up
  return {
    frame(audio, time) {},   // required, once per display frame
    resize(size) {},         // canvas was resized; size === ctx.size
    params(changed) {},      // only the keys that changed
    dispose() {},            // free GPU resources, timers, listeners
  };
}
```

The SDK owns the canvas and the animation loop. It calls `frame` on `requestAnimationFrame` with
the newest audio frame, so audio rate (~94/s) and display rate stay independent. Don't start your
own rAF loop and don't resize the canvas.

### `ctx`

| Property | Notes |
| --- | --- |
| `canvas` | Full-window canvas, already sized |
| `ctx2d` / `gl` / `gpu` / `three` | The one matching your `renderer`; others are `null` |
| `params` | Live parameter values |
| `assets` | `url(path)`, `text`, `json`, `image` (→ `ImageBitmap`), `arrayBuffer`; paths are repo-relative. `..` segments, leading `/`, backslashes and URL schemes are rejected |
| `size` | `{ width, height, cssWidth, cssHeight, dpr }`; `width`/`height` are drawing-buffer pixels |
| `renderScale` | 0.5–1, lowered automatically in Auto quality when frames run over budget |
| `quality` | `auto`, `high`, `balanced`, `battery` |
| `reduceFlashing` | Live; when true, at most 3 full-screen brightness changes per second |
| `log(...)` | Prints to the dev overlay's console |
| `id`, `name`, `renderer`, `apiVersion` | From the manifest |

Renderer details:

- **`2d`** — `ctx.ctx2d` is a `CanvasRenderingContext2D`.
- **`webgl2`** — `ctx.gl`, created with `powerPreference: "high-performance"`, `antialias: false`,
  `preserveDrawingBuffer: false`. The default framebuffer is cleared by the browser each frame;
  keep feedback effects in your own framebuffers.
- **`webgpu`** — `ctx.gpu = { adapter, device, context, format }`, context already configured.
  List a `fallback` entry for machines without WebGPU.
- **`three`** — declare `"libs": ["three"]`. `ctx.three = { THREE, renderer, scene, camera,
  autoRender }`. The SDK sizes the renderer and camera and, while `autoRender` is true, calls
  `renderer.render(scene, camera)` after your `frame`. Set `autoRender = false` to render yourself
  (e.g. through `EffectComposer` from `three/addons/`). You can `import * as THREE from "three"`
  and `import { … } from "three/addons/…"` directly — the SDK's import map points at the pinned
  host copy.

### `audio`

Passed to `frame`. Arrays are zero-copy views and are only valid during that call — copy what you
keep (`myCopy.set(audio.bands)`).

| Field | Type | Meaning |
| --- | --- | --- |
| `bands` | `Float32Array(64)` | Smoothed band levels 0–1, log-spaced 30 Hz – 16 kHz |
| `spectrum` | `Float32Array(1024)` | Linear magnitude, normalized 0–1 |
| `waveform` | `Float32Array(512)` | Latest samples, mono mix, −1..1 |
| `left`, `right` | `Float32Array(512) \| null` | Per-channel samples when the source is stereo |
| `rms`, `peak` | number | Level of the latest hop |
| `bass`, `mid`, `treb` | number | 1.0 = recent average for that band (≈0–2, MilkDrop style) |
| `bassAtt`, `midAtt`, `trebAtt` | number | Smoothed versions; good for motion |
| `onsetStrength` | number | Onset detection function |
| `onset` | boolean | A transient/beat landed this frame (carried forward if its audio frame was replaced before being drawn, so you see each onset exactly once) |
| `bpm` | number | Tempo, 0 until confident |
| `beatPhase` | number | 0–1 between predicted beats |
| `centroid` | number | Spectral brightness, 0–1 |
| `flux` | number | Spectral change, ≈0–1 |
| `silent` | boolean | Source is silent (or permission missing) |
| `frameIndex`, `sampleRate` | number | Host frame counter, source rate |
| `hostTime` | number | Host monotonic time (s) of the newest sample in the frame |

Before the first audio frame arrives, `frame` receives a silent all-zero frame (`silent: true`).

`time = { now, dt, frame }`: seconds since start (paused while hidden), seconds since the previous
frame (clamped to 0.1; 0 on the first frame), and the rendered-frame counter.

## Rules the sandbox enforces

Your plugin runs in `<iframe sandbox="allow-scripts">` on an opaque origin with a strict CSP:

- No network: `fetch` and `import` work only for your own repo files (`ctx.assets.url`), `data:`
  and `blob:` URLs. WebAssembly is allowed; `eval`/`new Function` are not.
- No storage, cookies, popups, navigation, or access to the host page.
- Errors thrown from `create` or `frame` are caught and shown. Three consecutive failing frames
  unload the visualizer and the host falls back to the previous one.
- A visualizer that blocks the page for 2 s (e.g. an infinite loop) is disabled until the user
  re-enables it.
- On WebGL context loss the SDK disposes your instance and calls `create` again.

## Performance

The target is 60 fps at 2560×1440 on an M1 MacBook Air with plugin time well under the 16.7 ms
frame. Allocate buffers once in `create`, not in `frame`. Use `renderScale`/`size` rather than
`window.devicePixelRatio`. Check the perf HUD (**P**) for your per-frame CPU time.
