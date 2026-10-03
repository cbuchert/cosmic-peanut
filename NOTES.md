# Notes: decisions and measurements

Newest first within each milestone. Numbers are from the dev machine unless stated
(Apple M4 Pro, macOS 26.6) — the PRD's reference machine is an M1 MacBook Air.

## Linux support (2026-10-02)

**Machine (not the M4 Pro above):** Linux 7.2 (CachyOS), i9-12900KF, RTX 4090 (driver 615.71),
PipeWire 1.6, WebKitGTK 2.52, Hyprland 0.56 on Wayland, 2560×1440 @ 60 Hz.

**Capture** (`capture/pipewire_source.py`): `pw-record --raw` on a pipe, 512-frame blocks.
`--latency 256` gives one block per 10.7 ms; 512 delivers two at once (a dropped hop). Per-app pids
come from `application.process.id`, else `pipewire.sec.pid`. A per-app target is pinned with
`node.dont-reconnect`: otherwise WirePlumber re-links `pw-record` to the microphone when the app's
stream ends. The watchdog marks the source `failed` when `pw-record` delivers no data for 1 s (4 s
before the first block, for a sink waking from suspend); silent audio still streams zero blocks.

| Measure (pink noise via `speaker-test`) | Result | Budget / macOS note |
| --- | --- | --- |
| Block interval, 5 s | p1/p50/p99 10.61 / 10.67 / 10.72 ms | 10.67 ms ideal |
| Headless host CPU, 60 s, `tools.cpu_budget` | **2.4%** (analysis 1.4, main 0.6, reader 0.2) | < 10% (macOS 6.6%) |
| Orbit bench, fullscreen 2560×1440 | 58.5–59.5 fps, p99 33 ms, 0.9–2.9% dropped | 60 fps, p99 20 ms |
| Audio-to-screen p95 (same runs) | 31.4–31.7 ms | 50 ms |
| App with window, Orbit, 1440p (% of one core) | `tidalviz` **30–33%**, WebProcess 10% | **over the budget** (macOS 13.8%) |

- **Windowed host CPU is 30–33%, over the 10% budget, and not fixed here.** The GTK main thread is
  25% of it. `py-spy record --native` shows no Tidalviz Python on the hot path, only GTK/GDK and
  NVIDIA's EGL-Wayland libraries; what wakes it ~92 times a second isn't established.
- **Crash on NVIDIA + native Wayland, and the fix.** The app died ~1 s after launch (`Gdk-Message:
  Error 71 (Protocol error)`). One variable at a time, 12 s launches (exit 124 = survived):

  | Variant | Exit | Error 71 |
  | --- | --- | --- |
  | baseline | 1, dead in ~1 s | yes |
  | `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 124 | 0 |
  | `__NV_DISABLE_EXPLICIT_SYNC=1` | 124 | 0 |
  | `GDK_BACKEND=x11` | 124 | 0 |

  `window_gtk.configure_gl_environment()` sets `__NV_DISABLE_EXPLICIT_SYNC=1` before GTK starts when
  `/proc/driver/nvidia/version` exists; a value the user set wins (`=0` brings the crash back).
- **Known gap: WebKitWebProcess segfaults on exit with the NVIDIA driver** (a core dump each
  time): `libwebkit2gtk` destructors call into `libnvidia-eglcore` after the window has gone. The
  app itself exits normally. Not fixed here.
- Not measured: switching the default output mid-stream, Flatpak apps.
- **Tried and dropped:** `WEBKIT_DISABLE_DMABUF_RENDERER=1` copies every frame through shared
  memory (Orbit 51.6 fps, WebKitWebProcess at 94.5% CPU, against 59.5 fps and 10.3% CPU with DMA-BUF
  kept); a Qt backend (WebEngine is Chromium, 524 MB); PyGObject as a default dependency (a bare
  `uv sync` would fail without headers), hence the `gtk` extra.

## Visualizer batch: Tentacube, Tie-Dye, Skull Trip, Dark Sun, Eclipse, Marbling, Laminar, Tetraballs (2026-09-28)

Built in parallel worktrees and merged one at a time. GPU times were measured on the M4 Pro at
2560×1440 while up to seven agents were rendering, so treat them as rough upper bounds (the
reference M1 Air is roughly 3–4× slower).

| Visualizer | Technique | GPU (M4 Pro, loaded) |
| --- | --- | --- |
| Tentacube | three.js; verlet tentacle chains (CPU, ~0.05 ms); material morph; Poincaré-disk tiling | ≤ 2.2 ms |
| Tie-Dye | half-res dye pass + full-res weave composite | 1.6–1.9 ms |
| Skull Trip | raymarched SDF skull (half res) over AA op-art stripes | 2.0–2.2 ms |
| Dark Sun | quarter-res watercolour washes + full-res sun/horizon; mirrored spectrum range | ~0.9 ms |
| Eclipse | procedural branching corona trees (noise gave worms/specks); third-res clouds | ~2.3 ms |
| Marbling | Jaffer drop/tine displacement, baked feedback with a 48-event queue | 1.4–2 ms |
| Laminar | stable-fluids sim (MacCormack, obstacle, confinement in the wake cone) | 3–3.6 ms |
| Tetraballs | raymarched metaballs; 9 materials (thin-film, Charlie sheen, dispersion…) | chrome ≤ 2.5; fire 3.5–10; smoke 4–9 |

- **Fire/smoke in Tetraballs likely miss 60 fps on an M1 Air at medium quality**; the low
  quality setting and auto render scale reduce them. To verify on the reference machine.
- **Photosensitivity:** every visualizer routes global brightness swings through the flash
  limiter. Skull Trip's check counts 4 changes/s at a 2% luminance threshold but 0 at 5%; WCAG's
  general-flash threshold is ~10% opposing changes, so it isn't a flash by that definition.
- **Harness:** the melody signal produced NaNs before t = 0 (negative modulo) and the drums kick
  peaked at ~30 Hz; both fixed. Headless WebKit paints a transparent page's unstyled iframe
  white, so backdrop colour in harness screenshots isn't reliable.
- Merging: parallel agents each appended a manifest entry and a test; a conflict can split a
  function in two, so the manifest test file is rebuilt from both sides rather than
  "keep both".

## Host CPU (2026-09-27)

Measured with `uv run python -m tools.cpu_budget` (headless host, WebSocket client in a separate
process so its CPU isn't counted) and an in-process sampler for the app with its window.

| Setup | Host process CPU |
| --- | --- |
| Headless, live TIDAL, before this work | ~7–8.6% (the earlier "~15%" probe counted its in-process client) |
| Headless, live TIDAL, after | **6.6%** — analysis 2.8, main/asyncio 1.5, catap drain 1.3, catap worker 0.8 |
| App with window, live TIDAL, after | 13.8% |
| App with window, live TIDAL, before (old code) | 23.3% |

- **Our code meets the < 10% budget.** The remaining ~7 points in the app are WKWebView's UI
  process, which lives in the host process and handles WebKit's per-frame layer commits and IPC
  at 60 fps. Getting the combined number under 10% would mean running the host in a separate
  process from the window — not done; it would meet the budget's letter, not its intent.
- **catap drain pacing** (`capture/catap_drain.py`): catap 0.6 polls its native ring every 1 ms
  (~1,000 wakeups/s for ~94 chunks). A wrapper around the private
  `AudioRecorder._drain_native_recorder` sleeps until just before the next chunk is due. It's
  guarded (no method ⇒ warning, catap untouched) and catap is pinned `~=0.6.0` so an upgrade is a
  deliberate step. This was most of the window-app improvement.
- Analysis: fewer, fused numpy calls per hop; planar mirrored ring with a zero-copy view of the
  newest frames; float32 spectrum after the float64 FFT. Golden-value tests pinned the outputs
  first. Analysis p50 ≈ 0.20–0.23 ms live.
- Tried and dropped: a lock-as-doorbell instead of the ring's Condition — no measurable gain.

## Integration — app, bench, e2e (2026-09-26)

- **Plugins were stuck at 20 fps in the app.** The shell's iframes ignore the pointer (so the
  shell sees the mouse), so the native click that lifts WebKit's cross-origin rAF throttle never
  reached the plugin. Now, while the active plugin reports < 40 fps, its iframe accepts the
  pointer; the shell then takes keyboard focus back. The fix is occasionally flaky in the real
  window (one bench run stayed at 22 fps); the host re-clicks every 2 s.
- **No 120 Hz WebKit preference.** Turning off `PreferPageRenderingUpdatesNear60FPSEnabled` made
  WKWebView pace frames irregularly: Orbit 48 fps / 26% dropped vs 59.9 fps / 0.56% at the default.
- **Bench, Orbit, live TIDAL audio, 2560×1440 canvas (M4 Pro, window alone):** 59.9 fps, 0.7%
  dropped, frame p99 37 ms (budget 20), audio-to-screen p95 ~33–57 ms (budget 50), analysis p50
  0.19 ms, capture→send p95 0.7 ms, **host CPU ~20% (budget 10%)**. Two app windows at once push
  latency to ~500 ms — measure alone.
- **Host CPU breakdown (headless probe):** analysis thread ~7% (Analyzer 0.46–0.54 ms thread CPU
  per hop live vs 44 µs in a hot loop: per-call numpy overhead on cold caches; `AnalysisContext.load`
  alone is 0.18 ms), catap capture workers ~6%, event loop ~2%. QoS user-interactive doesn't help.
  Reaching 10% needs far fewer numpy calls per hop (batching extractors) — open decision.
- **Frame contract:** waveform is now 2,048 samples per channel (Cosmic Peanut): mono 12,640 B,
  stereo 29,024 B.

## M1/M2 components — parallel lanes (2026-09-25)

Built in parallel worktrees (audio, host, plugins, sdk, shell, viz, spike) against the M0
contracts, then merged. The app entry point that wires them together is the next step.

**M1 spike: WKWebView (tools/spike/REPORT.md).** The architecture holds, with two changes:
- WebKit throttles rAF in a cross-origin iframe to **20 Hz until the user interacts with it**
  (no preference turns this off). One synthetic NSEvent click into the window after each plugin
  is ready lifts it. Host send → first iframe rAF: 47 ms p95 without, **17 ms p95 at 60 Hz and
  9 ms at 120 Hz** with it. Estimated audio-to-screen ≈ 33–49 ms, inside the 50 ms budget.
- The plugin iframe **shares the shell's WebContent process and main thread**: `while(true){}`
  freezes the shell. Heartbeat detection works; recovery needs
  `_killWebContentProcessAndResetState()` + `reload()` (plain reload does nothing).
- WebGL2 and WebGPU both work in the sandboxed iframe. rAF is 60 Hz on ProMotion unless
  `PreferPageRenderingUpdatesNear60FPSEnabled` is turned off. `performance.now()` has 1 ms
  resolution in WKWebView. On-top windows ignore the first fullscreen toggle.
- Site isolation (private `SiteIsolationEnabled` + plugin served from `localhost`) gives the
  plugin its own process so a hang doesn't freeze the shell — an M2 experiment, flag is unstable.

**Audio.** Analysis p50 44 µs / p99 124 µs in the benchmark; live on the real pipeline with TIDAL
p50 ≈ 0.5 ms, p99 0.77–0.91 ms (cores idle down between hops; the analysis thread uses Mach
real-time scheduling, without it p99 ≈ 1.8 ms). Capture → publish p95 0.9 ms. Zero per-frame
allocation (tracemalloc test). Onsets: every click detected once, 0.67 ms error. Tempo locks in
2.9 s at 120 ± 0.2 BPM. Reserved scalar 13 is now **`onsetAge`** (sub-hop onset timing).
Known gap: tempo can land an octave off on ambiguous material.

**Host.** Loopback p95 0.5 ms for 10.6 KB frames at 94 Hz, 100% delivered. The bootstrap page's
CSP carries a per-response nonce (the §3 CSP as first written blocked its own inline scripts —
the spike found the same). Paths reject hidden segments; dev harnesses and `*.test.js` are not
served.

**Plugins.** Dev-folder save → callback ≈ 30 ms. Real HTTPS fetch of a small GitHub repo ≈ 5.5 s.
Keys: built-ins use their folder name, dev folders `dev-<slug>-<hash8>`.

**SDK / shell.** SDK overhead is below WKWebView's 1 ms timer (µs-level in micro-benchmarks);
shell forwarding ≈ 3–20 µs per frame. Frames are forwarded by transfer.

**Viz.** At 2560×1440 in WebKit: Bars 0.1/0.2 ms, Undertow ≤0.05/0.1 ms (+~0.7 ms GPU), Orbit
0.1/0.5 ms (+~0.8 ms GPU), Template ≤0.05/0.1 ms CPU p50/p99. Vendored three 0.186.1 is 6.6 MB.

## M0 — contracts (2026-09-25)

- **Frame v1 channels are planar** (mono, left, right) instead of interleaved, so every waveform
  view is zero-copy. Mono 6,496 B, stereo 10,592 B. See docs/protocols.md §1.
- **Shell and SDK are plain ES modules with JSDoc types**, type-checked by `tsc --checkJs`. The PRD
  asks for TypeScript built at build time *and* a checkout that runs with only uv; shipping source
  that needs no build satisfies both, with no committed build output to drift. Node is dev-only.
- **aiohttp serves HTTP and the WebSocket** on one event loop (the PRD allowed aiohttp for HTTP and
  named `websockets` for WS); one dependency instead of two.
- **Manifest `fallback`** is the `id` of another entry in the same manifest.
- **catap live check:** system capture delivers 48 kHz stereo float32, 512-frame buffers
  (~94 callbacks/s) with real signal from TIDAL — the hop matches catap's buffer size.
