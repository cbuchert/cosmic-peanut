# Tidalviz PRD: modular audio visualizer for macOS

> Snapshot of the PRD (claude.ai doc, 2026-09-25). The living doc is the source of truth for scope.

## Summary and goals

Tidalviz is a macOS app that captures whatever audio the Mac is playing and drives real-time 2D or 3D visualizers, which are installed from git repos and run as sandboxed plugins. It is a modern take on Winamp's MilkDrop: the host does capture, analysis and plugin management, and the community writes the visuals in web tech.

The primary user is a web developer on an Apple Silicon Mac who wants to listen to TIDAL (or anything else) with visuals, and to write their own visualizers without learning native macOS development.

v1 is successful when:

- A user can build and launch a single `.app` with no BlackHole, no Xcode and no manual audio routing.
- A user can paste a git URL, and within 10 seconds of the clone finishing, that repo's visualizer is running.
- The bundled 2D and 3D reference visualizers hold 60 fps at 2560×1440 on an M1 MacBook Air, with audio-to-screen latency under 50 ms (see Performance).
- A plugin author can go from the template repo to a working visualizer with hot reload in under 15 minutes, using only a text editor and the app.

## Non-goals for v1

v1 is macOS-only, local-only and single-user. The following are explicitly out of scope, though the architecture should not block them:

- Windows or Linux support.
- Microphone or line-in capture (the `AudioSource` interface should allow it later).
- Loading MilkDrop `.milk` presets directly. A Butterchurn-based plugin could add this later without host changes.
- A hosted plugin marketplace, ratings or search. v1 installs from URLs the user pastes.
- Recording visuals to video, streaming output, or multi-monitor spanning.
- Code signing and notarization for public distribution. v1 is ad-hoc signed and built locally.
- Plugins that need network access, microphone, camera or file system access.

## Tech stack

The host is Python 3.12 packaged as a `.app` with PyInstaller. Rendering happens in a native WebKit view, so visualizers are plain JavaScript modules. Nothing in the build or runtime may require Xcode, the Xcode Command Line Tools, BlackHole or a system `git`.

| Layer | Choice | Why |
| --- | --- | --- |
| Audio capture | catap (Core Audio process taps, macOS 14.2+) | Captures system or per-app output with no virtual driver. Ships a universal2 wheel, and streams buffers to a callback via `on_buffer`. |
| Analysis | numpy (FFT via `numpy.fft`, or `scipy.fft` if benchmarks justify it) | Vectorized and fast enough for ~100 analysis frames/s on one core. |
| Window | pywebview (WKWebView backend) | Native window with no Electron runtime. Web tech for all rendering. |
| Host ↔ renderer transport | Local binary WebSocket (`websockets` on asyncio), bound to 127.0.0.1 | pywebview's `js_api` bridge serializes JSON per call and is too slow for per-frame data. Binary frames avoid JSON entirely. |
| Static serving | Small local HTTP server in the host (aiohttp or `http.server` in a thread) | Serves the host UI and plugin files with controlled headers (CSP, CORS), which `file://` cannot do. |
| Rendering | WebGL2 required, WebGPU optional (feature-detected), Canvas 2D | WebGL2 is available in every supported WKWebView. WebGPU is used only when present. |
| 3D library | three.js, vendored and version-pinned by the host | Most plugin authors know it. Vendoring means no CDN at runtime. |
| Git | dulwich (pure Python) | On macOS, `/usr/bin/git` is a stub that prompts to install developer tools. dulwich needs nothing extra. |
| Packaging | PyInstaller, arm64 first, with Info.plist `NSAudioCaptureUsageDescription` | No Xcode needed. The plist string appears in the permission prompt. |

A working prototype from an earlier session (catap capture, numpy analysis, pywebview window, WebGL2 feedback shader, PyInstaller spec) should be given to the agent alongside this PRD as a reference. Its per-frame `js_api` polling is the part to replace.

### Project tooling

The project uses uv for everything Python: interpreter, virtual environment, dependencies, lockfile and running commands. No `pip`, `requirements.txt`, manual venvs or `make` (on macOS, `make` is part of the developer tools this project avoids).

- **Project definition:** one `pyproject.toml` (PEP 621) with a committed `uv.lock`. Runtime dependencies go in `[project.dependencies]`. Tooling goes in dependency groups: `dev` (pytest, ruff, pyright, playwright) and `build` (pyinstaller).
- **Python version:** pinned with `.python-version` (3.12) and installed by `uv python install`. Nobody relies on a system or Homebrew Python.
- **Entry point:** `[project.scripts] tidalviz = "tidalviz.app:main"`, so `uv run tidalviz --dev <path>` works from a checkout.
- **Lint and format:** ruff for both (`uv run ruff check`, `uv run ruff format`), configured in `pyproject.toml`.
- **Types:** pyright in strict mode for `tidalviz/`, run with `uv run pyright`. Astral's `ty` can replace it once stable.
- **Tests:** `uv run pytest`.
- **Tasks:** small Python scripts under `tools/` run with `uv run` (for example `uv run python -m tools.build_app`) instead of a Makefile.
- **Layout:** `src/tidalviz/` (src layout), `tests/`, `tools/`, `web/shell`, `web/sdk`, `plugins/` (built-ins).
- **CI:** GitHub Actions with `astral-sh/setup-uv`, running `uv sync --locked` so a stale lockfile fails the build.
- **One check to verify in M1:** PyInstaller has to bundle cleanly from a uv-managed standalone Python. If it doesn't, pin a python.org framework build through uv instead, and record the decision in `NOTES.md`.

## Architecture

The system has two halves joined by one binary WebSocket: a Python host that captures, analyzes and manages plugins, and a web renderer that runs one sandboxed plugin at a time. Every box below is a module behind an interface, so any part can be replaced without touching the others.

```mermaid
flowchart LR
  subgraph Host[Python host]
    SRC[AudioSource\ncatap system / app / file / synthetic] --> RING[PCM ring buffer]
    RING --> AN[Analyzer\nfeature extractors]
    AN --> ENC[Frame encoder\nbinary v1]
    ENC --> WS[WebSocket server\n127.0.0.1]
    REG[Plugin registry] --- GIT[Git fetcher\ndulwich]
    REG --- HTTP[Static server\nCSP + CORS]
  end
  subgraph Renderer[WKWebView]
    SHELL[Host shell UI] --> PH[PluginHost\niframe manager]
    PH -->|MessagePort, transferable| SDK[Plugin SDK runtime]
    SDK --> PLUG[Visualizer plugin\n2D / WebGL2 / WebGPU / three.js]
  end
  WS -->|audio frames| SHELL
  SHELL |control JSON| WS
  HTTP -->|plugin files| PLUG
```

### Modules

| Module | Responsibility | Key interface |
| --- | --- | --- |
| `tidalviz.capture` | Produce mono or stereo float32 PCM with timestamps | `AudioSource.start(on_samples)`, `.stop()`, `.format`. Implementations: `CatapSystemSource`, `CatapAppSource`, `FileSource` (WAV, for tests), `SyntheticSource` (for tests and demo mode) |
| `tidalviz.analysis` | Turn PCM into an `AudioFrame` at a fixed hop | `Analyzer` runs an ordered list of `FeatureExtractor`s. Each declares the fields it writes, so new features plug in without editing the core |
| `tidalviz.transport` | Encode frames, serve WebSocket and control messages | `FrameEncoder.encode(frame) -> bytes`, versioned header |
| `tidalviz.plugins` | Manifest validation, install, update, pin, local dev folders, file watching | `PluginRegistry`, `GitFetcher`, `DevFolderWatcher` |
| `tidalviz.server` | Local HTTP for the shell and plugin files, with per-response headers | Routes described under Sandboxing |
| `tidalviz.app` | Startup, settings persistence, window, lifecycle, permission checks | Settings are JSON in `~/Library/Application Support/Tidalviz/` |
| `web/shell` | Host UI, plugin switching and crossfades, parameter panels, perf HUD | Plain TypeScript, built to static files at build time |
| `web/sdk` | Runs inside each plugin iframe: bootstrap, frame delivery, lifecycle, params, error reporting | The plugin API contract below |

### Threads

- **Main thread:** pywebview and Cocoa (required by macOS).
- **catap worker thread:** copies PCM into the ring buffer and returns immediately. No analysis here.
- **Analysis thread:** wakes every hop, computes one `AudioFrame`, and hands it to the event loop with `call_soon_threadsafe`.
- **Asyncio thread:** WebSocket, HTTP and control. It broadcasts only the newest frame; if a client is behind, older frames are dropped, never queued.

In the renderer, the shell forwards each frame to the active plugin iframe over a `MessagePort`, transferring the buffer rather than copying it. The plugin renders on its own `requestAnimationFrame` using the newest frame it has, so audio rate and display rate stay independent.

## Audio capture and analysis

The host analyzes audio at a fixed 512-sample hop (about 94 frames/s at 48 kHz) and ships every plugin the same versioned feature set. Plugins never see raw capture APIs.

### Sources

- **All system audio** (default): `catap.record_system_audio(on_buffer=…)`, excluding Tidalviz's own process.
- **One app:** `catap.record_process(name, on_buffer=…)`. The UI lists apps currently producing audio, using catap's process enumeration, rather than asking for a typed name.
- **File** and **synthetic** sources for tests, demos and plugin development without music playing.
- Switching sources must not restart the renderer or the active plugin.
- If catap reports a capture failure (for example after sleep/wake or an output-device change), the host restarts the source automatically, with backoff, and shows a status line.
- Silence detection: macOS delivers zeroed buffers when permission is missing. If a source produces only silence for 4 s, the shell shows how to grant permission.

### Analysis settings

| Setting | Default | Notes |
| --- | --- | --- |
| Sample rate | Source rate (usually 48 kHz) | Never resample for analysis. |
| FFT size | 2048, Hann window | 4096 as an option for more bass detail. |
| Hop | 512 samples | Frame rate = sample rate / hop. |
| Bands | 64, log-spaced, 30 Hz to 16 kHz | Mapped from dB to 0–1 with a pink-noise tilt, fast attack, slow release. |
| Auto gain | On | Slow-moving normalization so quiet tracks still drive visuals. |

### Frame contract (binary v1)

Each frame is one little-endian binary WebSocket message. Every array starts at a 4-byte-aligned offset so the SDK can wrap it in a `Float32Array` without copying. A change that breaks this layout bumps `version`; adding scalars at the end of the scalar block does not.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | Magic `TVZ1` |
| 4 | u16 | Version (1) |
| 6 | u16 | Flags: bit 0 onset this frame, bit 1 silent, bit 2 stereo waveform |
| 8 | u32 | Frame index |
| 12 | f32 | Sample rate (Hz) |
| 16 | f64 | Host monotonic time (s) |
| 24 | u16 × 4 | Counts: bands (64), spectrum bins (1024), waveform samples per channel (512), scalars (16) |
| 32 | f32 × scalars | See scalar list below |
| then | f32 × bands | Smoothed band levels, 0–1 |
| then | f32 × spectrum | Linear magnitude spectrum, normalized |
| then | f32 × waveform × channels | Latest samples, −1 to 1, interleaved if stereo |

Scalars, in order: `rms`, `peak`, `bass`, `mid`, `treb`, `bassAtt`, `midAtt`, `trebAtt`, `onsetStrength`, `bpm`, `beatPhase`, `centroid`, `flux`, then reserved. `bass`, `mid` and `treb` follow MilkDrop's convention: 1.0 means average loudness for that band over the last few seconds, so values run roughly 0–2. The `*Att` versions are smoothed copies. `bpm` is 0 until the tempo estimate is confident, and `beatPhase` runs 0–1 between predicted beats.

A full frame is about 8.5 KB, or about 800 KB/s over loopback, which is well within budget.

## Visualizer plugin format

A visualizer is a plain ES module plus a JSON manifest, living in a git repo; one repo can hold several visualizers. Installation never runs a build step or `npm`, so what's committed is what runs.

### Manifest

Every repo has a `tidalviz.json` at its root. It always uses the `visualizers` array, even for a single visualizer, so there is one shape to validate.

```json
{
  "apiVersion": 1,
  "visualizers": [
    {
      "id": "undertow",
      "name": "Undertow",
      "description": "Feedback-warp rings that breathe with the bass.",
      "author": "Jane Doe",
      "entry": "src/undertow.js",
      "renderer": "webgl2",
      "libs": [],
      "thumbnail": "thumbs/undertow.png",
      "params": [
        { "id": "speed", "type": "number", "label": "Speed", "min": 0, "max": 2, "step": 0.01, "default": 1 },
        { "id": "tint", "type": "color", "label": "Tint", "default": "#7cf0ff" },
        { "id": "mirror", "type": "boolean", "label": "Mirror", "default": false },
        { "id": "mode", "type": "select", "label": "Mode", "options": ["rings", "bars"], "default": "rings" }
      ]
    }
  ]
}
```

- `renderer` is one of `2d` (Canvas 2D), `webgl2`, `webgpu` or `three`. It decides which context the SDK creates. `webgpu` plugins may list `"fallback": "webgl2"` with a second entry.
- `libs` names host-provided libraries. v1 provides `three` (pinned, with `three/addons/`). Plugins may also vendor their own dependencies as relative imports.
- `id` must be unique within the repo and match `^[a-z0-9-]{1,40}$`. A visualizer's global key is `<repo key>/<id>`.
- The host validates manifests against a published JSON Schema and shows specific errors (field path and reason) when validation fails.

### Entry module API

The entry's default export is a factory. It may be async. The SDK owns the canvas, context creation, sizing and the animation loop; the plugin only draws.

```js
export default async function create(ctx) {
  // ctx.canvas        full-window canvas, already sized
  // ctx.gl | ctx.ctx2d | ctx.gpu | ctx.three   context for the declared renderer
  //                    (ctx.three = { THREE, renderer, scene, camera } with defaults the plugin may replace)
  // ctx.params        current parameter values
  // ctx.assets        url(path), text(path), json(path), image(path), arrayBuffer(path), scoped to the repo
  // ctx.size          { width, height, dpr }
  return {
    frame(audio, time) {},  // required; time = { now, dt, frame }
    resize(size) {},        // optional
    params(changed) {},     // optional; only changed keys
    dispose() {},           // optional; release GPU resources
  };
}
```

`audio` exposes the frame contract as named fields and zero-copy typed arrays: `bands`, `spectrum`, `waveform` (plus `left` and `right` when stereo), the scalars (`bass`, `bassAtt`, `bpm`, `beatPhase` and so on), `onset` and `silent`. It is only valid during that `frame` call. Plugins that keep data must copy it.

### SDK duties

- Create the context with host-controlled options (`powerPreference: "high-performance"`, no `preserveDrawingBuffer`) and cap DPR by the user's quality setting.
- Catch errors in `create` and `frame`. After 3 consecutive frame errors, report to the host, which unloads the plugin and falls back to the previous one.
- Handle WebGL context loss by disposing and recreating the plugin.
- Measure the plugin's CPU time per frame and report it to the host for the perf HUD.
- Ship TypeScript declarations (`tidalviz.d.ts`) in the template repo so authors get autocomplete without a build step.

## Installing from git

Users add a repo by URL. The host fetches it with dulwich, pins it to an exact commit, and only moves to a newer commit when the user approves. Installed plugins work fully offline.

### Accepted inputs

- `https://host/owner/repo(.git)` for any public git host.
- `owner/repo` as GitHub shorthand.
- An optional `#ref` suffix for a branch, tag or commit, for example `owner/repo#v1.2.0`. The default is the remote's default branch.
- SSH URLs and private repos are out of scope for v1.

### Install flow

- Shallow-fetch the ref (depth 1) into a temp directory. Time out after 60 s.
- Resolve the exact commit SHA and enforce limits: 200 MB total, 5,000 files, no symlinks that point outside the repo. Submodules and Git LFS are ignored, with a warning.
- Validate `tidalviz.json`. On failure, show the errors and delete the temp directory.
- Show a trust prompt with the URL, the commit, the visualizers found, and a plain note that plugins are code from the internet and run sandboxed with no network access.
- Move the checkout to the store and register it. Launch the first visualizer.

### Storage

```
~/Library/Application Support/Tidalviz/
  settings.json
  registry.json                 # url, ref, pinned commit, previous commit, installed/checked times
  plugins///  # read-only checkout, .git stripped
  cache/                        # thumbnails, temp fetches
```

`<repo key>` is a readable slug of host, owner and repo, plus the first 8 hex characters of the URL's SHA-256, so two forks never collide. The host keeps the current and the previous commit per repo, and deletes older ones.

### Updates

- At launch, at most once every 24 hours, the host checks each repo's ref against the remote. Update checks never apply updates automatically.
- Available updates show the new commit's short SHA and message. Updating repeats the install flow, including validation.
- Rollback to the previous commit is one click, with no network needed.

### Local dev folders

- "Add folder" registers a local path in place, without copying it. This is the plugin-authoring workflow.
- The host watches the folder (`watchfiles`). On any change, the active visualizer hot-reloads within 300 ms, keeping its current parameter values.
- Manifest or runtime errors appear in an overlay with the file, line and message, and the last working version keeps running underneath.
- `Tidalviz --dev <path>` launches straight into a dev folder.

Built-in visualizers ship inside the app bundle in the same format, so the host has no special code path for them.

## Sandboxing and security

Plugins are untrusted code from the internet. Each runs in a sandboxed iframe on its own origin, with no network, no storage, and no way to reach the shell or the host except the audio frames and messages the SDK hands it.

### Isolation

- Each plugin loads in `<iframe sandbox="allow-scripts">`, with no `allow-same-origin`, top navigation, popups or forms. Its origin is opaque, so it has no cookies, storage or access to the shell DOM.
- The shell and plugin files are served from different local ports, so they are different origins even without the sandbox.
- The host serves one bootstrap page per plugin. It contains the SDK, an import map for the `libs` the plugin declared, and the entry import.
- The shell talks to plugins only through a `MessagePort`. It validates every message against a schema. Plugin-supplied names, descriptions and error messages are rendered as text, never as HTML.

### Headers on plugin responses

- `Content-Security-Policy`: `default-src 'none'`; scripts, images, fonts, media and `connect-src` limited to the plugin server's origin plus `data:` and `blob:`; `'wasm-unsafe-eval'` allowed; no `unsafe-eval`. The shell's port is never allowed.
- `Access-Control-Allow-Origin: *` on plugin static files only. This is needed because ES modules loaded from an opaque origin are CORS requests.
- The static server only serves files inside registered plugin directories. It rejects `..`, absolute paths and symlinks that escape.

### Local server hardening

- Both servers bind to 127.0.0.1 on random ports chosen at launch.
- Requests whose `Host` header isn't `127.0.0.1:<port>` are rejected, to block DNS rebinding.
- The control WebSocket requires a per-launch random token and checks that the `Origin` is the shell's origin.
- pywebview's `js_api` exposes only window controls (full screen, quit). Web Inspector is on in dev builds only.

### Hung plugins

In WebKit, an iframe may share the shell's main thread, so a plugin stuck in an infinite loop can freeze the whole window. The renderer sends a heartbeat to the host every 500 ms. If it misses 2 s, the host reloads the web view with that visualizer disabled and tells the user why. Plugins that fail this way can be re-enabled manually.

## Performance

Performance is a release gate, not a polish item: every target below has an automated measurement, and a milestone isn't done until its targets pass on the reference machine. The reference is an M1 MacBook Air (8 GB) on macOS 15, plugged in, driving a 2560×1440 display.

### Budgets

| Metric | Target | How it's measured |
| --- | --- | --- |
| Frame rate, reference 2D and 3D plugins | 60 fps sustained, fewer than 1% dropped frames over 10 min | Benchmark mode, frame timestamps from the SDK |
| Frame time p99 | Under 20 ms | Same |
| Audio-to-screen latency | Under 50 ms p95 | Synthetic click source; sample timestamp to the first frame where the plugin sees the onset |
| Capture to frame sent | Under 15 ms p95 | Host timestamps |
| Analysis cost | Under 1 ms per frame | Host timer around the `Analyzer` |
| Host process CPU | Under 10% of one core, steady state | `psutil`, 60 s average |
| Shell overhead in renderer | Under 1 ms per frame, excluding plugin time | SDK and shell timers |
| Host memory | Under 200 MB RSS, under 5% growth over 1 hour | `psutil` in soak test |
| Launch to first visual frame | Under 2 s warm, under 4 s cold | App log timestamps |
| Switch visualizer | Under 500 ms for built-ins | Shell timer |
| Hot reload | Under 300 ms from file save to new frame | Dev-folder test |

### Rules for hot paths

- No per-frame allocations in the SDK or shell. Decode frames into reusable typed-array views, and pool the WebSocket receive buffers.
- In Python, preallocate every numpy array, use an index-based circular buffer (no `np.roll`), and keep `on_buffer` to a single copy.
- Never queue stale frames anywhere. Every stage keeps only the latest.
- Stop rendering when the window is hidden, minimized or fully covered. Pause analysis when no renderer is connected.

### Adaptive quality

The user picks a quality mode: Auto (default), High, Balanced or Battery. High renders at native DPR and matches the display's refresh rate where WebKit allows it; Balanced caps DPR at 1.5; Battery caps DPR at 1.0 and frame rate at 30 fps. In Auto, if frame time stays over budget for 2 s, the SDK lowers render scale in 10% steps, down to 50%, and raises it again after 10 s of headroom. Plugins can read the current scale but don't have to handle it.

### Instrumentation

- A perf HUD (toggle with P) shows fps, frame time p50 and p99, plugin CPU time per frame, audio latency, dropped audio frames and host CPU.
- `Tidalviz --bench <visualizer> --seconds 60 --source synthetic` writes a JSON report. CI runs it against the reference plugins and fails when a metric regresses more than 10% from the stored baseline.

## Host UI

The visual fills the window, and every control lives in overlays that fade out after 3 s without mouse movement. The UI should feel like a player, not a settings app.

### Window

Tidalviz is a standalone desktop app with its own window that sits anywhere on the desktop, like a small always-running player. It is never a browser tab.

- A normal, resizable macOS window (minimum 320×180) that remembers its size, position and display between launches, and restores safely if that display is gone.
- **Float on top:** keeps the window above other apps. Toggle it from the View menu or with T.
- **Borderless mode:** hides the title bar so only the visual shows. The window can be dragged from anywhere and resized from its edges, and the overlays still appear on hover.
- **Full screen** stays available (F), and leaving it returns the window to its previous spot.
- The window keeps rendering while another app has focus. It stops only when minimized, hidden or fully covered, as the Performance section describes.
- A standard Dock icon and app menu, with Quit (⌘Q) and Close Window (⌘W) behaving as usual on macOS.
- **Source picker:** "All audio" plus a live list of apps currently producing sound, which updates as apps start and stop.
- **Library:** a grid of installed visualizers with thumbnail, name, repo and a 2D/3D badge. From here users can add a URL, add a dev folder, update, roll back or remove.
- **Parameters:** controls generated from the manifest's `params`. Values persist per visualizer, with a reset.
- **Auto-cycle:** optionally move to the next visualizer every N seconds (off by default), with a 1.5 s crossfade. During the fade both iframes render, and the frame-rate budget is relaxed for that window.
- **Keys:** N and Shift+N for next and previous, F full screen, H hide overlays, L library, P perf HUD, Esc close panels.
- **Permission help:** when a source is silent because permission is missing, show one sentence of explanation and a button that opens System Settings at the right Privacy & Security pane, where macOS allows deep links.
- **Photosensitivity:** a first-launch notice about flashing visuals, and a "Reduce flashing" setting, on by default. The SDK passes it as `ctx.reduceFlashing`, and reference plugins must cap full-screen brightness changes at 3 per second when it's on.
- **Accessibility:** every control reachable by keyboard, visible focus rings, and text rendered at the system font size.

## Reference plugins, packaging and testing

### Reference plugins

Four built-ins prove each part of the plugin contract, and double as performance benchmarks and author examples.

| Plugin | Renderer | Proves |
| --- | --- | --- |
| Bars | `2d` | Canvas 2D path, spectrum and waveform fields, params |
| Undertow | `webgl2` | Feedback-warp shaders ported from the prototype, loaded with `ctx.assets``.text` |
| Orbit | `three` | 3D scene: 64 instanced meshes on a ring, camera driven by `beatPhase`, bloom from `three/addons` at half resolution |
| Template | `webgl2` | Smallest useful plugin. Published as its own template repo with `tidalviz.d.ts` and a README covering the dev-folder workflow |

### Packaging

- `uv run python -m tools.build_app` builds `dist/Tidalviz.app` with PyInstaller from the `build` dependency group. It bundles catap's native dylib, the built shell and SDK, vendored three.js and the built-in plugins.
- Info.plist sets `NSAudioCaptureUsageDescription`, `LSMinimumSystemVersion` 14.2 and a bundle identifier. The app is ad-hoc signed, arm64 first.
- `uv run tidalviz --dev <path>` runs from source with Web Inspector enabled.
- A fresh checkout needs only uv: `uv sync` then `uv run tidalviz`.
- Node and a bundler are allowed at build time for the shell and SDK. The runtime app must not depend on Node.

### Testing

- **Analysis (pytest):** a 1 kHz sine lands in the right band; onsets fire on a click track with under 10 ms error; a 120 BPM click track reports 120 ± 1 BPM within 8 s.
- **Frame contract:** a golden binary fixture is encoded by Python and decoded by the SDK in both test suites, so the two sides can never drift apart.
- **Plugins:** manifest schema cases, and install, update and rollback against local fixture repos created with dulwich (no network in unit tests).
- **Security:** hostile fixture plugins that try network access, reading the shell, reading storage, path traversal, an infinite loop and runaway memory. Each must be contained as the Sandboxing section describes.
- **End to end:** Playwright with WebKit (the closest match to WKWebView) drives the shell against a host running the synthetic source. It covers loading, switching, hot reload and parameter changes.
- **Performance:** benchmark mode on a macOS arm64 CI runner for every pull request, plus a nightly 1-hour soak test.
- **Manual release checklist:** capturing real TIDAL audio, the permission-denied flow, sleep and wake, and switching output devices (for example connecting AirPods mid-song).

## Milestones

Build in four milestones, in order. Each ends with its tests and performance gates passing and a short `NOTES.md` entry recording decisions and measured numbers. Start M1 with a one-day spike that measures the WebSocket → shell → iframe path in WKWebView, because the whole design rests on it.

| Milestone | Scope | Done when |
| --- | --- | --- |
| M1 Audio core | Capture sources, ring buffer, analyzer and extractors, frame encoder, WebSocket, minimal shell, SDK running the built-in Bars plugin in its sandboxed iframe | Analysis and frame-contract tests pass. Latency under 50 ms p95. Host CPU under 10%. Real TIDAL audio drives Bars. |
| M2 Plugin runtime | Manifest schema, full SDK API, all four renderer types, CSP and CORS headers, error handling, context-loss recovery, hang detection, local dev folders with hot reload, Undertow and Orbit | Hostile fixtures are contained. All three reference plugins meet frame budgets. Hot reload under 300 ms. |
| M3 Git install | URL parsing, dulwich fetch, limits, trust prompt, storage layout, pinning, update checks, rollback | A pasted URL is running within 10 s after the fetch. Installed plugins work offline. Fixture-repo tests pass. |
| M4 Product | Library, source picker, params panel, auto-cycle and crossfade, quality modes, perf HUD, benchmark mode and CI, photosensitivity setting, packaging | Every performance budget passes on the reference machine. The manual release checklist passes on the built `.app`. |

## Open questions

- If the M1 spike shows WKWebView iframes can't hold the latency and frame budgets, is a native renderer acceptable, or should the budgets change?
- Does WebKit on macOS 15 and 26 run sandboxed cross-origin iframes on a separate thread or process? The answer changes how serious the hang risk is. Verify during M1.
- Should plugins be able to request extra analysis features (chroma, MFCCs, stems) through a manifest `features` field? This is proposed for API v2.
- Is auto-cycle off by default the right call, or should the app behave like MilkDrop and cycle out of the box?
- Are private repos (with a token stored in the Keychain) wanted for v1.1?
