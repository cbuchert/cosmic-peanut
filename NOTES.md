# Notes: decisions and measurements

Newest first within each milestone. Numbers are from the dev machine unless stated
(Apple M4 Pro, macOS 26.6) — the PRD's reference machine is an M1 MacBook Air.

## Lattice (2026-10-22)

A new builtin `webgl2` visualizer: an endless cubic lattice (a rounded cube at every node, rods
along the three axes) that the camera flies through. Params: Speed, Reactivity, Rod thickness,
Fog, Palette (steel, brass, ink), Background (fog, none), Quality (low, medium, high).

- **Render:** one full-screen raymarch by domain repetition (`p - round(p)`: exact distances, so
  rays run quickly down the empty channels) at Quality's render scale (0.5 / 0.67 / 0.85, 56 / 80 /
  110 steps), then a full-resolution composite. Headlight + key light, 5-sample AO. The fog mixes
  in display space: mixed in linear light, the cream ink fog washed the lattice out within a cell
  (and every fog looked thinner than its density on dark backgrounds).
- **Motion** (`lib/lattice-camera.js`): a seeded walk cell centre → adjacent cell centre (runs of
  2–5 cells, then a perpendicular turn), smoothed by a uniform cubic B-spline (C2) and flown by
  arc length. The spline stays ≥ 0.47 cell from every rod axis and ≥ 0.6 from every node (tested
  over 2 minutes × 3 seeds), so the cube size is capped to fit (`geometry`). The view looks 1.2
  cells ahead along the path (turns start early and turn about half as fast); `up` is parallel
  transported. Drag look-around eases back with Möbius Field's critically damped spring.
- **Music:** the beat envelope (`lib/lattice-beat.js`, tempo-locked / strong onsets, 80 ms
  smoothstep rise, back to 0 by 0.9 beat) drives only the fly-speed surge (+50 % × Reactivity) and
  the pulses. Each beat launches one pulse from the node nearest the path 1.6 cells ahead; its front
  runs 3 cells out along the rods (on the rod graph that's L1 distance, so the shader needs no
  graph walk), easing in over 80 ms and out by 0.9 beat. Nothing pumps the whole scene. Rods take
  their axis's band energy (x bass, y mids, z treble) against a 4 s auto-gain, eased and
  flash-limited; cube faces scroll a 64 × 256 RGBA8 history (spectrogram, waveform on y faces), one
  row per frame, older on cubes farther from the camera. Reduce flashing: pulses × 0.3 and ≥ 1/3 s
  apart, axis light × 0.35. Reduce motion: Speed 1 → 0.25, no surge, running light and pulse
  travel × 0.3.
- **Frame time** (harness, WebKit, 2560 × 1440, `sync=1`, `rep=4`; WebKit clamps the clock to
  1 ms, so these are coarse): low p50 2 / p99 3 ms; medium p50 1.5–2.5 / p99 2–2.75 ms; high p50
  2.5–4.5 / p99 5.75–6.25 ms; 58.8 fps throughout. Flash check under the 10 Hz strobe: ≤ 3 rises/s
  at 2 % with Reduce flashing on (lum range 0.34–0.46).
- **Not test-first:** the GLSL (no JS copy of it, by design), the entry module's GL wiring (driven by
  the harness: resize, every param flipped, dispose, no errors) and the look (tuned by stills).

## Beat tracking: Ballroom harness and a new tracker (2026-10-22)

`uv run python -m tools.beat_eval` streams all 698 Ballroom clips hop by hop through the real
Analyzer (9 s on 10 cores) and scores the beats (each `beatPhase` wrap while `bpm > 0`) with
mir_eval against the Krebs annotations. `tests/test_beat_eval_ballroom.py` holds these as a floor
when the dataset is present (`--fetch`, 1.5 GB to `~/.cache/tidalviz/ballroom`).

| Tracker | F | CMLt | AMLt | Acc1 | Acc2 |
| --- | --- | --- | --- | --- | --- |
| Old (ACF tempo + onset PLL), all 698 | 0.524 | 0.378 | 0.592 | 0.646 | 0.913 |
| ChaChaCha (best) | 0.717 | 0.696 | 0.908 | 0.991 | 0.991 |
| Quickstep (~200 BPM) | 0.485 | 0.001 | 0.720 | 0.000 | 1.000 |
| Waltz (3/4) | 0.284 | 0.119 | 0.235 | 0.309 | 0.700 |
| **New (beat score + comb tempo), all 698** | **0.661** | **0.522** | **0.688** | **0.726** | **0.950** |
| ChaChaCha | 0.763 | 0.751 | 0.813 | 1.000 | 1.000 |
| Quickstep | 0.534 | 0.000 | 0.754 | 0.000 | 1.000 |
| Waltz | 0.460 | 0.255 | 0.446 | 0.400 | 0.782 |

- **What moved the numbers** (half-set sweeps, then the full set): the cumulative beat score
  for phase (α 0.9, tightness 5, the paper's values; F 0.52 → 0.59); holding the tempo through
  weak estimates instead of dropping after ~1 s (+0.04 F; lock coverage was 82 %, Waltz 43 %);
  a comb over the ACF at 1–4 × the period with equal weights plus a ±16-frame moving-mean
  threshold on the envelope (Davies & Plumbley 2007; Acc1 0.64 → 0.73, Waltz and Jive most).
  Prior (120 BPM, ±1 octave) and range (60–180) were already best; a 220 ceiling trades CMLt
  for F, and a higher confidence bar costs far more than it saves. Analysis p99 78 µs.
- **`bpm` is now held until 1 s of silence** (a weak estimate never drops it). The old tracker
  also locked onto a made-up tempo (148–175 BPM) from silence; it no longer estimates while silent.
- **The old tracker had tempo mostly right up to an octave (Acc2 0.91); phase and continuity
  were the weak part (CMLt 0.38).** Quickstep (~200 BPM) sits above the 60–180 search range, so
  it still always halves (CMLt 0, AMLt fine); Waltz is still the weakest genre.
- **Libraries ruled out:** madmom (last PyPI release 2018, breaks on Python ≥ 3.10, models
  CC BY-NC-SA), BeatNet (needs madmom + PyTorch), BTrack/aubio (GPL) and essentia (AGPL) under
  our MIT license, librosa (offline only); `analysis/rhythm.py` implements the published
  algorithms instead (cumulative score: Stark, Davies & Plumbley, DAFx 2009).
- **Tie-Dye moves on the beat:** with a confident tempo an onset's surge is scaled to 0.2 and the
  dye swell follows the beat; before, an off-beat onset pushed the flow further than a beat
  (0.161 vs 0.129 unit radii).

## More reactive backgrounds: Tie-Dye, Skull Trip, Dark Sun, Eclipse, Marbling (2026-10-21)

Background motion = mean frame-to-frame pixel change over the background (subject excluded),
5–10 s deterministic windows in the harness; beat response = motion 150 ms after a strong onset
÷ 150 ms before. Each agent used its own meter, so compare rows, not visualizers.

| Visualizer | Loud ÷ silence (main → now) | Beat response (main → now) | What changed |
| --- | --- | --- | --- |
| Tie-Dye | 2.6 → 7.6 | 1.29 → 1.57 | new bands born per beat, coloured by the spectrum; auto pattern morphs every 32 beats |
| Skull Trip | 3.4 → 8.9 | 2.57 → 2.85 | stripes are contours of a distance field: closed loops born at beat-seeded emitters grow off screen |
| Dark Sun | 4.2 → 64.5 | 2.49 → 3.90 | flowing washes, beat-locked range drop and horizon shock, ground ripples; sun 2.4 → 32 |
| Eclipse | 1.3 → 19.6 (30.8 with water) | 1.01 → 1.45 | orbiting, re-forming clouds; water reflection (off/low/mid) |
| Marbling | ~3–9 → ~260 | 1.7–3.1 → 4.2 | every beat pours (by spectrum), currents between drops, tempo-locked combing |

- **Skull Trip is budget-limited on purpose:** every stripe motion shares one per-pixel alternation
  budget (≤ 3 Hz with Reduce flashing). On main the skull's nod/chomp moved every contour and spent
  most of it; the field now uses the skull's rest outline and the budget goes to the background.
- **Silence:** several visualizers now move *less* in silence than before, by design.
- **Harness:** each agent wrote its own motion meter; kept one built-in meter (`meter=1`, named
  zones) plus `motion_hook.py`; `silent=1` now zeroes levels in every audio mode.

## Blaze: flame-test materials and sparks (2026-10-15)

Eleven new palettes after the original four: propane, copper, boron, sodium, lithium, strontium,
potassium, calcium, barium (flame-test colours) and iron, nickel (sparks).

- **Blackbody rendering:** a material is `soot` × the blackbody glow plus `line` × `strength` × t^1.2
  (its emission lines/bands, filling the body more evenly than the soot), tone-mapped together.
  Propane is nearly soot-free, hence blue. Display gamma flattens colour ratios hard, so strontium
  and calcium need almost no green in their lines to read as red and brick orange.
  **Simple rendering:** a keyed ramp through a hand-picked `swatch`.
- **Iron and nickel barely tint a flame** (they burn like "natural"); they throw sparks:
  `lib/sparks.js`, a 1,024-slot structure-of-arrays pool (swap-remove, no per-frame allocation)
  spawned from the fuel line by rejection sampling on fuel, so sparks fly from the loud columns,
  at a rate set by the bass stoke and onset flare. Gravity + drag arcs; colour is blackbody cooling
  over life. Iron sparks fork into 3–5 short, hotter children (steel's carbon burst); nickel's are
  mixed 70% toward white and never fork. Drawn as soft additive streaks (35 ms of motion) after the
  composite. Spark motion runs on sim time, so Speed and reduce-motion slow it.
- Known gap: the spark pass's GPU cost isn't measured (worst case 1,024 streaks, a 172 KB
  `bufferSubData` per frame).

## Blaze: blackbody rendering (2026-10-15)

A new *Rendering* param: **blackbody** (default) or **simple** (the original hand-keyed ramps,
byte-identical stills).

- **Blackbody is Tetraballs' fire model, not a new one.** Heat t → K = 800 + 2400 · t^1.4, Planck's
  law at 610/550/465 nm, emission ∝ t^2.2, ACES tone map + display gamma. A test reads
  `shaders/tetraballs/volume.glsl` so the two can't drift. (Tetraballs' SIGGRAPH citations are its
  thin-film and sheen materials; the fire is plain Planck.)
- **Still a 256-texel LUT built on the CPU**, rebuilt on palette/rendering change: the GPU path and
  its cost are unchanged. `gain` (2) stands in for the density Tetraballs' ray march accumulates.
- **Palettes are re-tints of the blackbody fire:** blue gas and green chemical swap channels; ember
  mono is a deep-red → orange curve on luminance (the brightest channel saturates early and looked flat).
- The low-heat tips are less red than the old ramp (r/g ≈ 3.8 at t = 0.2, against 14): that is a
  ~1050 K blackbody after display gamma, so the red-tips test now asks r > 3.5 g.

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

## Background and visual opacity (2026-10-02)

Two persisted settings, `backgroundOpacity` (0–1, default 0) and `visualOpacity` (0.1–1, default
1), live only while *Transparent background* is on.

- **Two sliders, and the visual's goes on a `.viz-layer` wrapper.** *Transparent background* only
  removes the black backdrop, but most visualizers paint nearly every pixel, so the window stays
  opaque. The backdrop alpha sits on the stage background. The visual opacity sits on a new
  `.viz-layer` around the plugin iframes, not on `.stage` (that would fade the backdrop too) and not
  on each iframe (the plugin host animates their inline `opacity` for the crossfade).
- **Fade live on `input`, save on `change`.** Each `settings` message rewrites settings.json.
- Visual stops at 0.1 so the visual can fade but never vanish; Background has no floor.

Unit and e2e tests pass on macOS (2026-10-14). Known gap: the GPU cost of the extra compositing
layer below opacity 1 is unmeasured.

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
