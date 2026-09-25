# Tidalviz visualizer template

The smallest useful Tidalviz visualizer: one WebGL2 fragment shader that
draws a spectrum halo reacting to bass, beats and all 64 frequency bands. Copy this folder (or use
it as a template repo), change the shader, and you have your own visualizer.

## What's here

| File | What it is |
| --- | --- |
| `tidalviz.json` | The manifest: id, name, entry module, renderer (`webgl2`) and the params users can tweak. Must sit at the repo root. |
| `src/main.js` | The entry module. Its default export `create(ctx)` compiles the shader and returns `frame(audio, time)`, which uploads audio as uniforms and draws one full-screen triangle. |
| `src/scene.frag` | The fragment shader: all the visuals. Start here. |
| `src/flash.js` | Photosensitivity limiter (see below). Keep it. |
| `tidalviz.d.ts` | Type declarations for the plugin API, for editor autocomplete via `// @ts-check`. It's a copy of `web/sdk/tidalviz.d.ts` in the Tidalviz repo: **keep it in sync** when the API version changes. |
| `thumbs/halo.jpg` | Library thumbnail (keep it small, under 60 KB). |

No build step and no `npm`: what you commit is exactly what runs.

## Develop with hot reload

1. Copy this folder somewhere, e.g. `~/viz/my-viz`, and change `id` and `name` in `tidalviz.json`.
2. Run it:
   - from a Tidalviz checkout: `uv run tidalviz --dev ~/viz/my-viz`, or
   - in the app: **Library → Add folder** and pick the folder.
3. Edit `src/scene.frag` or `src/main.js` and save. The visualizer reloads in about 300 ms and keeps
   your param values.
4. Mistakes show in an **error overlay** with file and line (shader compile errors include the GLSL
   log) while the last working version keeps running. `ctx.log(...)` prints to the overlay's console.
   Press **P** for the perf HUD, including your plugin's CPU time per frame.

## The audio you get

`frame(audio, time)` receives the newest analysis frame (~94 per second) on every display frame.

| Field | Meaning |
| --- | --- |
| `bands` | `Float32Array(64)`, smoothed levels 0–1, log-spaced 30 Hz – 16 kHz |
| `spectrum` | `Float32Array(1024)`, linear magnitude 0–1 |
| `waveform` | `Float32Array(512)`, latest samples −1..1 (`left`/`right` too when stereo, else `null`) |
| `rms`, `peak` | Level of the latest hop |
| `bass`, `mid`, `treb` | 1.0 = recent average for that range (≈0–2, MilkDrop style) — punchy |
| `bassAtt`, `midAtt`, `trebAtt` | Smoothed versions — better for motion |
| `onset`, `onsetStrength` | A transient landed this frame / how strong |
| `bpm`, `beatPhase` | Tempo (0 until confident) and 0–1 position between beats (0 = on the beat) |
| `centroid`, `flux` | Brightness and spectral change, ≈0–1 |
| `silent` | Nothing playing (or capture permission missing) |

`time` is `{ now, dt, frame }` in seconds. The arrays are views that are only valid during the
call: copy what you keep (`myCopy.set(audio.bands)`). Full reference: `tidalviz.d.ts`.

**Params**: add entries to `params` in `tidalviz.json` (`number`, `color`, `boolean`, `select`);
the app renders the controls. Read them from `ctx.params` (always current) and implement
`params(changed)` to react.

**Performance**: the target is 60 fps at 2560×1440 on an M1 MacBook Air. Allocate in `create`,
never in `frame` (no `new`, no array/object literals, no string building per frame). Size your
work from `ctx.size`, not `window.devicePixelRatio`.

## Photosensitivity

Users have a "Reduce flashing" setting, on by default, exposed as `ctx.reduceFlashing`. When it's
on, keep full-screen brightness changes to **at most 3 per second**. `src/flash.js` does that for you:
pass anything that flashes the whole screen through `flash.step(value, time.dt, ctx.reduceFlashing)`,
as `main.js` does for the onset pulse.

## Sandbox rules

Your code runs in a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin, strict CSP):

- No network. `fetch`/`import` work only for files in your own repo (use `ctx.assets.text(path)`,
  `json`, `image`, `arrayBuffer`, or `ctx.assets.url(path)`), plus `data:` and `blob:` URLs.
- No storage, cookies, popups, navigation or access to the host page. No `eval`/`new Function`;
  WebAssembly is allowed.
- Don't start your own `requestAnimationFrame` loop or resize the canvas; the SDK does both.
- Errors in `create`/`frame` are caught; three failing frames in a row unload the visualizer. A
  page blocked for 2 s gets disabled. On WebGL context loss your `dispose` runs and `create` is
  called again.
- Want three.js? Use `"renderer": "three"` with `"libs": ["three"]` and `import * as THREE from "three"`
  (plus `three/addons/...`) — the host provides a pinned copy.

## Publish

Push the folder to any git host (GitHub, GitLab, Codeberg, your own server) with `tidalviz.json`
at the repo root. Users paste the repo URL into **Library → Add URL**; Tidalviz clones it, validates
the manifest, and lists every visualizer in it. Push new commits to ship updates — users get them
with **Update** and can roll back.
