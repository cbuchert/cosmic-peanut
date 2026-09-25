# M1 spike: WebSocket → shell → sandboxed iframe in WKWebView

Throwaway spike code. It won't be merged, so it was not built test-first. The raw evidence for
every number below is in `tools/spike/results/*.json`, and each file records the command-line
config it ran with. Scripts: `tools/spike/run.py`, `server.py`, `static/`,
`window_controls.py`, `fullscreen_ontop.py`.

**Verdict: the architecture holds, with two changes the shell/SDK/host must make.**

1. WebKit throttles rAF in a cross-origin iframe to **20 Hz** until the user interacts with it.
   The host must send one synthetic native click into the iframe. Without it, audio-to-screen
   is 48 ms p95, right at the budget. With it, the result is 17 ms p95.
2. By default the plugin iframe shares the shell's WebContent process and main thread. An
   infinite loop in a plugin freezes the shell. Heartbeat hang detection is therefore required,
   and it works, but recovery must **kill the WebContent process**. A plain `reload()` does
   nothing.

## Setup

- MacBook Pro, M4 Pro, built-in Liquid Retina XDR (ProMotion, 120 Hz). The display is scaled
  to "looks like" 1800×1169 pt, with DPR 2. The machine ran on battery with Low Power Mode off.
- macOS 26.6.2 (25G83), pywebview 6.2.1 (Cocoa/WKWebView), Python 3.12, aiohttp.
- **Window:** 1280×720 pt, DPR 2. Its content area is 1280×692 CSS px, so the WebGL2 canvas is
  **2560×1384 device px** (the closest match to 2560×1440). A fullscreen run used a
  **3600×2260 px** canvas.
- **Pipeline:**
  - Two aiohttp servers on 127.0.0.1 with random ports:
    - the shell server, with the §3 shell CSP;
    - the plugin server, with the §3 plugin CSP and `ACAO: *`.
  - A 10,592 B §1-shaped stereo frame at **93.75 Hz**. Its f64 at offset 16 holds
    `time.time()`.
  - The shell forwards each ArrayBuffer **by transfer** over a MessagePort to
    `<iframe sandbox="allow-scripts">` on the plugin port. The iframe gets there by: bootstrap
    page → inline import map → inline module → static `import "./util.js"` + `import("dep")`
    via the import map.
  - The iframe then renders a full-window WebGL2 fBm shader every rAF. Each frame uploads the
    spectrum as an R32F texture from a zero-copy Float32Array view.
- **Clocks:**
  - Python time is `time.time()`. JS time is `performance.timeOrigin + performance.now()`.
  - Offsets are measured with 30 ping round trips (min-RTT pick):
    - shell ⇄ Python: 0.5–1.6 ms;
    - iframe ⇄ shell.
  - **WKWebView `performance.now()` has 1 ms granularity**, and ping RTTs read as 0. So all
    JS-side numbers are ±1 ms, and tiny negative minimums are quantization.
- Stats cover only frames sent ≥ 1.5 s after the iframe reported ready.
- **Latency definitions:**
  - "→ next rAF" is the time from host send to the first iframe rAF callback after arrival. It
    is measured over all frames and is the honest audio-to-screen-minus-capture figure.
  - "→ consume" counts only frames that were newest at a rAF. It is optimistic.

## Numbers (pywebview/WKWebView unless noted; ms)

| Run (results file) | host→shell WS p50/p95/p99 | shell→iframe p50/p95/p99 | host→iframe recv p50/p95/p99 | **host→next rAF p50/p95/p99** | iframe rAF | frame time p50/p99 | dropped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default, no interaction (`wk_1280x720_noclick`) | 1.5/2.6/3.4 | ≤1 | 0.4/1.8/3.1 | **22.9/47.1/50.1** | **20 Hz** (shell 60) | 49/51 | 0 |
| **Host NSEvent click on ready** (`wk_1280x720_click`) | 1.2/2.3/3.3 | 0/1/1 | 1.3/2.5/3.4 | **9.5/17.3/18.3** | 60 Hz | 17/18 | 0 in 13 s |
| Click + 120 Hz pref (`wk_120hz_click`) | 0.6/2.2/3.6 | 0/1/1 | 0.8/2.3/3.7 | **4.9/8.9/9.8** | 120 Hz | 8/10 | 2 in 10 s |
| Click, fullscreen 3600×2260 px (`wk_fullscreen_click`) | 1.1/2.4/3.1 | 0/1/1 | 1.1/2.5/3.6 | 8.8/16.6/19.8 | ~66 Hz (variable) | 15/23 | 13 in 12 s |
| Click + SiteIsolation, plugin on `localhost` (`wk_siteisolation_localhost`) | 1.0/2.0/2.8 | 0/2/4 | 1.3/2.6/6.2 | 9.5/17.1/19.1 | 60 Hz | 17/18 | 0 |
| Playwright WebKit 26.6 headless, no click (`pw_headless_noclick`) | 0.7/2.7/3.7 | 1/1/3 | 1.1/3.8/5.2 | 23.9/48.1/50.7 | 20 Hz | 50/51 | 0 |
| Playwright + `page.mouse.click` (`pw_headless_click`) | 1.6/3.3/4.8 | 0/1/2 | 2.0/4.1/5.6 | 10.3/17.8/19.0 | 60 Hz | 17/18 | 0 |

"→ consume": 6.8/11.7 ms p50/p95 at 60 Hz, and 5.1/8.9 ms at 120 Hz.

**Shell main-thread cost per frame:**

- The whole `onmessage` (DataView read + `postMessage(buf,[buf])`) has a mean of
  **~15–25 µs**. The max is 1 ms, which is the timer quantum.
- Micro-benchmark over 2000 × 10,592 B buffers: ≤0.5 µs/msg to transfer and ~1–2 µs/msg to
  structured-clone copy. The crossfade copy is therefore fine.
- The iframe WebGL draw CPU time is ≤1 ms.

**Python side:** the asyncio send scheduler was 1.06 ms late at p50 and ~1.3 ms at p95. The
WS→port→iframe hop adds 0–1 ms, so WS delivery (~1–3 ms) is the only real transport term.

**Budget:**

- The terms are capture→send (budget < 15 ms), send→next rAF (17 ms p95 at 60 Hz, 9 ms at
  120 Hz) and about one compositor frame to glass.
- That totals **≈ 49 ms worst case at 60 Hz, and ~33 ms at 120 Hz**.
- Without the throttle fix the budget is blown: 48 ms p95 before capture and display are added.

## Open questions: answers and evidence

1. **Separate process or thread? No (defaults, macOS 26.6).**
   - `WKPreferences._features()` reports `SiteIsolationEnabled` default False.
   - Only one WebContent process is spawned.
   - `while(true){}` in the iframe (`wk_hang`) caused all of these:
     - shell heartbeats stopped immediately (last at 3.39 s, then none for 10 s);
     - the shell's rAF and WS reads stopped;
     - a `postMessage` sent just before the loop never reached the shell;
     - the WebContent process ran at ~96–100% CPU.
   - Playwright WebKit behaves the same (`pw_hang`).
   - **Opt-in isolation works.** With `SiteIsolationEnabled=1` **and** the plugin on a
     different *site* (`localhost` vs `127.0.0.1`; ports don't make a different site), the
     iframe got its own WebContent process (`wk_siteisolation_localhost_hang`). That process
     spun at 99%, while the shell kept 60 fps, heartbeats (max gap 505 ms) and WS. Latency was
     unchanged.
   - With both servers on 127.0.0.1 it still ran in one process (`wk_siteisolation_hang`).
   - The flag is private and marked unstable.
2. **Heartbeat hang detection: necessary and effective for detection.** Recovery after 2 s
   without a heartbeat:

   | Recovery action | Result |
   | --- | --- |
   | `reload()` (`wk_hang_reload`) | Does NOT recover. |
   | `_killWebContentProcess` + `reload` (`wk_hang_kill`) | Does NOT recover. |
   | `_killWebContentProcessAndResetState` + `reload` (`wk_hang_killreset`) | **Recovers.** New pid, WS reconnected 0.12 s later, heartbeats back within 0.6 s, iframe ready 0.5 s later at 60 Hz. |
   | SIGKILL of `_webProcessIdentifier()` + `reload` (`wk_hang_sigkill`) | **Recovers.** |

   `_webProcessIsResponsive` still said True at 2 s, so WebKit's own detection is too slow.
3. **ES modules and import map from the opaque-origin iframe:** these work. Module fetches carry
   `Origin: null`, and `ACAO: *` is enough. **But the §3 plugin CSP as written blocks the
   bootstrap's inline import map and inline module script.** The probe saw two
   `script-src-elem` violations and `moduleRan: false` (`wk_csp_probe`, and the same in
   Playwright). Adding `'sha256-…'` hashes for both inline scripts fixes it.
4. **WebGL2:** yes (WebGL 2.0, "Apple GPU", `OES_texture_float_linear`). **WebGPU:**
   `navigator.gpu` is present in the sandboxed iframe, and `requestAdapter()` resolves
   (vendor/arch apple).
5. **Web Inspector:** `start(debug=True)` sets `developerExtrasEnabled` and auto-opens the
   inspector. `isInspectable` stays False, so Safari's Develop menu needs `setInspectable_(True)`.
6. **Throttling when minimized, hidden or occluded** (`wk_occlusion`):
   - Minimized or `orderOut`: rAF → 0 in shell and iframe, `visibilityState` → `hidden` in
     both, and the 500 ms heartbeat interval is throttled to ~1 s (one 1.58 s gap). WS frames
     keep arriving.
   - Fully covered by another window: no throttling (60 Hz, `visible`).
7. **User agent:**
   `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`.
   There is no `Version/` token, unlike Playwright's `Version/26.6 Safari/605.1.15`.
   `crossOriginIsolated` is false.
8. **rAF rate:** 60 Hz on the 120 Hz panel by default (`PreferPageRenderingUpdatesNear60FPSEnabled`
   is on). With it disabled, a true 120 Hz.
9. **Cause of the 20 Hz iframe rAF:**
   - These cases stayed at 20 Hz:
     - same-port but sandboxed, in `wk_sameport_sandboxed`;
     - cross-origin with `allow-same-origin`, in `wk_cross_allowsameorigin`.
   - A same-origin iframe without a sandbox ran at 60 (`wk_sameorigin_nosandbox`).
   - A real CGEvent click lifts it, and so does an NSEvent sent to the NSWindow without moving
     the cursor.
   - This is WebKit's non-interacted cross-origin frame throttling. It applies per document and
     has no preference to turn it off.

## pywebview on macOS 26

- `frameless` works (full-size content, hidden traffic lights), and so does `on_top`
  (level 25 ⇄ 0).
- `min_size` limits user resizing only.
- `js_api` round trip is ~0–1 ms (one 48 ms first call).
- **Gotcha:** at `on_top` level the first `toggle_fullscreen()` is silently ignored, framed or
  frameless. Dropping `on_top` first fixes it.
- pywebview's `is_fullscreen` flag drifts, so read `NSWindowStyleMaskFullScreen` instead.

## Recommendations

1. **Host:** after each iframe `ready`, send one NSEvent click at the iframe's centre. Then
   verify with the SDK's reported fps and re-click if fps ≈ display/3. The shell and SDK must
   ignore that event.
2. **Hang recovery:** `_killWebContentProcessAndResetState()` + `reload()`, with SIGKILL as the
   fallback. Pause the watchdog while the window is minimized or hidden, or disable hidden-page
   timer throttling.
3. **WebKit configuration:** wrap `WKWebViewConfiguration` (pywebview has no hook; see
   `run.py:patch_features`) to:
   - offer 120 Hz;
   - `setInspectable_(True)` in dev;
   - optionally evaluate Site Isolation with the plugin on `localhost` in M2.
4. **Fix the §3 CSP:** add hashes for the generated inline scripts.
5. **Fullscreen:** clear `on_top` before toggling, and use the real `styleMask` state.
6. **Shell/SDK:**
   - Forward by transfer as designed (noise-level cost).
   - Use `visibilitychange` to pause.
   - Treat 1 ms timers as the resolution for perf stats.
   - Feature-detect WebGPU.
7. **e2e:** Playwright WebKit reproduces the throttle, hang, CSP and latencies faithfully. Use
   `page.wait_for_timeout`, never `time.sleep`. A `time.sleep` run stalled the page
   (`pw_timesleep_stall`).
