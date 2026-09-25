# Internal protocols

The contracts between Tidalviz's parts. The public plugin API is in
[`plugin-api.md`](plugin-api.md). Change a contract here in the same commit as the code.

```
catap thread ──PCM──▶ ring ──▶ analysis thread ──bytes──▶ asyncio loop ──WS binary──▶ shell
                                                             ▲   │                     │ MessagePort
                                             control JSON ───┘   └── HTTP (2 servers)   ▼ (transfer)
                                                                                 plugin iframe (SDK)
```

## 1. Binary frame v1 (host → shell → plugin)

One little-endian binary WebSocket message per analysis frame. Every array starts at a 4-byte
aligned offset, so the SDK wraps each in a `Float32Array` view without copying.

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | Magic: bytes `T V Z 1` (`0x315A5654` read as LE u32) |
| 4 | u16 | Version = 1 |
| 6 | u16 | Flags: bit 0 onset, bit 1 silent, bit 2 stereo |
| 8 | u32 | Frame index |
| 12 | f32 | Sample rate (Hz) |
| 16 | f64 | Host monotonic time (s) of the newest sample in this frame |
| 24 | u16 × 4 | Counts: bands `B` (64), spectrum bins `S` (1024), waveform samples per channel `W` (512), scalars `C` (16) |
| 32 | f32 × C | Scalars (order below) |
| 32+4C | f32 × B | Band levels 0–1 |
| … | f32 × S | Magnitude spectrum, normalized |
| … | f32 × W | Waveform, mono mix |
| … | f32 × W × 2 | Only when the stereo flag is set: left plane, then right plane |

Decisions vs. the PRD: channels are **planar** (mono, then left, then right) rather than
interleaved, so `waveform`, `left` and `right` are all zero-copy views. Size: 6,496 B mono,
10,592 B stereo (~1 MB/s on loopback).

Scalar order (indices are stable; new scalars are appended, which does not bump the version):

| # | Name | # | Name |
| --- | --- | --- | --- |
| 0 | `rms` | 7 | `trebAtt` |
| 1 | `peak` | 8 | `onsetStrength` |
| 2 | `bass` | 9 | `bpm` |
| 3 | `mid` | 10 | `beatPhase` |
| 4 | `treb` | 11 | `centroid` |
| 5 | `bassAtt` | 12 | `flux` |
| 6 | `midAtt` | 13–15 | reserved (0) |

Decoders must use the counts from the header, not constants. The golden fixture pair
`tests/fixtures/frame_v1_{mono,stereo}.{bin,json}` is produced by the Python encoder
(`uv run python -m tools.make_frame_fixtures`) and decoded by the SDK's tests; both suites must pass.

## 2. Python interfaces

```python
# tidalviz/frame.py — shared value type
@dataclass(slots=True)
class AudioFrame:
    index: int; sample_rate: float; host_time: float
    onset: bool; silent: bool
    scalars: NDArray[float32]   # shape (16,), SCALAR_NAMES order
    bands: NDArray[float32]     # (64,)
    spectrum: NDArray[float32]  # (1024,)
    waveform: NDArray[float32]  # (512,) mono
    left: NDArray[float32] | None; right: NDArray[float32] | None   # (512,) when stereo

# tidalviz/capture — PCM producers
class AudioSource(Protocol):
    @property
    def format(self) -> SourceFormat: ...            # sample_rate: float, channels: 1 | 2
    def start(self, on_samples: OnSamples) -> None: ...
    def stop(self) -> None: ...
OnSamples = Callable[[NDArray[float32], float], None]
#   samples: shape (n, channels) float32, only valid during the call (copy once, into the ring)
#   t: host time.monotonic() of the LAST sample in the block
# Implementations: CatapSystemSource, CatapAppSource(name), FileSource(wav), SyntheticSource(kind)
# Failures: sources expose `failed: threading.Event`; the pipeline restarts them with backoff.

# tidalviz/analysis
class FeatureExtractor(Protocol):
    fields: tuple[str, ...]                          # scalar names / arrays it writes
    def process(self, ctx: AnalysisContext, out: AudioFrame) -> None: ...
class Analyzer:                                      # runs extractors in order
    def __init__(self, sample_rate: float, channels: int, settings: AnalysisSettings): ...
    def process(self, ring: RingBuffer, host_time: float) -> AudioFrame: ...   # reuses one AudioFrame

# tidalviz/transport
def encode(frame: AudioFrame) -> bytes              # binary v1
def decode(data: bytes) -> AudioFrame               # for tests / tooling
class FrameHub:                                      # lives on the asyncio loop
    def publish(self, data: bytes) -> None           # keeps only the newest; never queues
```

Threads: catap worker → `on_samples` copies into the ring and returns. The analysis thread wakes
each hop (512 samples), runs the `Analyzer`, encodes, and calls
`loop.call_soon_threadsafe(hub.publish, data)`. The hub sends the newest frame to each client whose
previous send has completed and drops the rest. Analysis pauses while no renderer is connected.

## 3. HTTP servers

Two aiohttp servers on the asyncio thread, both bound to `127.0.0.1` on random ports. Every request
whose `Host` header is not exactly `127.0.0.1:<that port>` gets 421.

**Shell server** (`S` = `http://127.0.0.1:<shell port>`) — CSP `default-src 'self'; img-src 'self'
<plugin origin> data:; frame-src <plugin origin>; connect-src 'self' ws://127.0.0.1:<shell port>;
style-src 'self' 'unsafe-inline'`.

| Route | Serves |
| --- | --- |
| `GET /` | `web/shell/index.html` |
| `GET /shell/<path>` | `web/shell/*` |
| `GET /config.json` | `{ "token", "pluginOrigin", "dev": bool }` — requires `?token=` |
| `GET /ws?token=<t>` | Control WebSocket (§4). Rejects a bad token or `Origin` ≠ `S` |

pywebview opens `S/?token=<t>`; the token is random per launch.

**Plugin server** (`P` = `http://127.0.0.1:<plugin port>`) — on every response:
`Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff` and CSP `default-src 'none';
script-src P 'wasm-unsafe-eval' blob: data:; img-src P data: blob:; media-src P data: blob:;
font-src P data:; connect-src P data: blob:; style-src P 'unsafe-inline'; worker-src P blob:`.
The bootstrap page's CSP adds a fresh `'nonce-<n>'` to `script-src`, and its inline scripts carry
`nonce="<n>"` (without it CSP blocks the inline import map and boot script). `style-src` includes
`P` so `/sdk/bootstrap.css` and plugin stylesheets load. Dev-folder responses add `Cache-Control:
no-store`. Both servers send `nosniff`; errors (404, 405, 421) carry the same headers.

| Route | Serves |
| --- | --- |
| `GET /v/<repoKey>/<vizId>/` | Generated bootstrap page (below) |
| `GET /r/<repoKey>/<path>` | Files inside the registered plugin directory only; 404 for `..` (literal or percent-encoded), absolute paths, empty or hidden (`.`-prefixed, e.g. `.git`) segments, encoded `/`, `\\` or NUL, directories, and symlinks resolving outside it. Same rules for `/sdk` and `/lib/three` |
| `GET /sdk/<path>` | `web/sdk/*` |
| `GET /lib/three/<path>` | `web/vendor/three/*` |

Bootstrap page (generated by the host in Python; values are JSON-encoded with `<`, `>` and `&`
escaped as `\u003c` etc. so plugin-controlled strings can't break out of the script):

```html
<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/sdk/bootstrap.css">
<script type="importmap">{"imports":{"three":"/lib/three/three.module.js","three/addons/":"/lib/three/addons/"}}</script>
<script type="module">
  import { boot } from "/sdk/sdk.js";
  boot({ key: "<repoKey>/<vizId>", entry: "/r/<repoKey>/<entry>", base: "/r/<repoKey>/", manifest: <entry JSON> });
</script>
```

The import map is included only when the entry declares `libs: ["three"]`.

## 4. Control WebSocket (shell ⇄ host)

Binary messages host→shell are frames (§1). Text messages are JSON `{ "type": ..., ... }` in both
directions. Receivers ignore unknown types and validate the fields of known ones.

Host → shell:

| type | Fields |
| --- | --- |
| `hello` | `version: 1`, `pluginOrigin`, `visualizers: VizInfo[]`, `repos: RepoInfo[]`, `settings`, `sources: SourceInfo[]`, `activeSource`, `active: key \| null`, `dev: bool` |
| `visualizers` | `visualizers: VizInfo[]`, `repos: RepoInfo[]` (registry changed) |
| `reload` | `key` — dev folder changed; hot-reload if active |
| `manifestError` | `repo`, `errors: {path, message}[]` |
| `sources` | `sources: SourceInfo[]`, `active` |
| `status` | `level: "info"\|"warn"\|"error"`, `text` (plain text), `id?` |
| `silence` | `silent: bool`, `seconds` — permission hint after 4 s of silence |
| `stats` | `hostCpu`, `rssMb`, `analysisMsP50`, `captureToSendMsP95`, `droppedFrames`, `latencyMsP95?` (1/s) |
| `installPrompt` | `id`, `url`, `commit`, `visualizers: {id,name}[]` — trust prompt |
| `installResult` | `id`, `ok`, `error?` |
| `updates` | `repos: {repo, commit, message}[]` |
| `disabled` | `key`, `reason` — hung/crashed plugin was disabled |

`VizInfo = { key, repo, id, name, description, author, renderer, thumbnailUrl|null, params:
ParamSpec[], values: ParamValues, disabled: bool, dev: bool, entryUrl, pageUrl }`
`RepoInfo = { repo, url|null, path|null, commit|null, previous|null, dev: bool, builtin: bool }`
`SourceInfo = { id: "system" | "app:<pid>" | "synthetic:<kind>" | "file:<name>", name }`

Shell → host:

| type | Fields |
| --- | --- |
| `heartbeat` | `t` — every 500 ms; 2 s without one ⇒ host reloads the web view with the active visualizer disabled |
| `select` | `key` — active visualizer changed (persisted) |
| `params` | `key`, `values` (full set, persisted) |
| `setSource` | `id` |
| `settings` | partial settings object (persisted): `quality`, `reduceFlashing`, `autoCycleSeconds`, `hudVisible`, … |
| `pluginError` | `key`, `message`, `file?`, `line?`, `fatal: bool` |
| `perf` | `key`, `fps`, `frameMsP50`, `frameMsP99`, `pluginMsP50`, `shellMs`, `renderScale`, `dropped` (1/s) |
| `onsetSeen` | `frameIndex` — SDK saw the onset of that frame (latency measurement) |
| `install` | `url` → host fetches, then `installPrompt` |
| `installConfirm` | `id`, `accept: bool` |
| `addFolder` | `path?` — omitted ⇒ host opens a native folder picker |
| `update` / `rollback` / `remove` | `repo` |
| `enable` | `key` — re-enable a disabled visualizer |
| `window` | `action: "fullscreen" \| "floatOnTop" \| "borderless" \| "quit"` |

## 5. Shell ⇄ plugin iframe

The shell creates `<iframe sandbox="allow-scripts" src="<pageUrl>">` and, after its `load` event,
a `MessageChannel`. It sends `port2` with `iframe.contentWindow.postMessage({ type: "tidalviz:init",
... }, "*", [port2])`. The SDK accepts exactly one init from `window.parent`. Everything afterwards
goes over the port.

Shell → SDK (port):

| Message | Notes |
| --- | --- |
| `{type:"tidalviz:init", params, quality, renderScaleMax, maxDpr, fpsCap, reduceFlashing, visible}` | Via `window.postMessage` with the port |
| `ArrayBuffer` | A binary v1 frame, **transferred** (the shell keeps no reference). During a crossfade the second iframe gets a copy |
| `{type:"params", changed}` | |
| `{type:"settings", quality?, maxDpr?, fpsCap?, reduceFlashing?}` | |
| `{type:"visibility", visible}` | Hidden ⇒ SDK stops its rAF loop |
| `{type:"dispose"}` | SDK calls `dispose()`, then the shell removes the iframe |

SDK → shell (port):

| Message | Notes |
| --- | --- |
| `{type:"ready"}` | `create` resolved and the first frame rendered |
| `{type:"error", message, file?, line?, fatal}` | `fatal` for a `create` failure or 3 consecutive frame errors |
| `{type:"perf", fps, frameMsP50, frameMsP99, pluginMsP50, renderScale, dropped}` | 1/s |
| `{type:"onsetSeen", frameIndex}` | First rendered frame that consumed an onset frame |
| `{type:"log", text}` | From `ctx.log`; plain text |
| `{type:"contextLost"}` | Informational; the SDK recreates the plugin itself |

Every message is untrusted: the shell checks `type` and field types and renders strings with
`textContent` only.
