# Cosmic Peanut

A music visualizer for macOS and Linux. It captures whatever your computer is playing (TIDAL,
Spotify, a browser tab) and drives visualizers written in plain JavaScript that run sandboxed. No
BlackHole, no audio routing, no Xcode. The app and its Python package are called **Tidalviz**.

Built-in visualizers: **Cosmic Peanut** (waveform rings drifting over an invisible sphere),
**Pulsar** (*Unknown Pleasures*-style ridge lines), **Orbit** (3D), **Undertow** (feedback
warp), **Bars**, and a **Template** to start your own.

## Requirements

- macOS 14.2 or later, Apple Silicon, **or** Linux with PipeWire (see [Linux](#linux))
- [uv](https://docs.astral.sh/uv/) — it installs the right Python for you
- Node 22+ only if you work on the web code (the app itself never needs it)

## Run it

```sh
git clone git@github.com:cbuchert/cosmic-peanut.git
cd cosmic-peanut
uv sync
uv run tidalviz
```

Play some music. The first time, macOS asks to let your terminal capture system audio. If the
visuals stay flat, allow it in **System Settings → Privacy & Security → Screen & System Audio
Recording** (the app's permission button opens that page).

The window is transparent, borderless and floats on top by default. Drag it by the top bar;
change each of these under **Settings**.

| Key | Does |
| --- | --- |
| N / Shift+N | Next / previous visualizer |
| L | Library (add a git URL or a local folder) |
| F | Full screen |
| T | Float on top |
| H | Hide overlays |
| P | Performance HUD |
| Esc | Close panels |

Options: `--source system | app:<pid> | synthetic:demo`, `--dev <folder>` (below), and
`--bench <visualizer> --seconds 60` (writes a performance report).

## Linux

Linux works with PipeWire (the default on current Fedora, Ubuntu and Arch). Capture needs no
permission or audio routing, and the window uses WebKitGTK.

Install PipeWire's tools, GTK 3, WebKit2GTK 4.1, the cairo and GLib development files and a C
compiler (on Arch: `pipewire pipewire-audio gtk3 webkit2gtk-4.1 cairo pkgconf gcc`), then:

```sh
uv sync --extra gtk
uv run --extra gtk tidalviz
```

- **Per-app capture** follows the app's process: if it stops playing, capture retries and resumes
  when the same process plays again; a restarted app has to be selected again.
- **Float on top** is the compositor's job on Wayland, so that setting does nothing there; use your
  compositor's own float toggle (Hyprland's works as is).
- **NVIDIA:** Tidalviz sets `__NV_DISABLE_EXPLICIT_SYNC=1` to avoid a WebKitGTK crash on Wayland;
  set it to `0` yourself to opt out.

## Write a visualizer

```sh
cp -r plugins/template ~/my-viz
uv run tidalviz --dev ~/my-viz
```

Edit `~/my-viz/src/main.js` and save: it hot-reloads in about 300 ms. Errors show in an overlay
while the last working version keeps running. The API is in
[docs/plugin-api.md](docs/plugin-api.md), with types in `plugins/template/tidalviz.d.ts`. To share
a visualizer, push its folder to a git host; others paste the URL into **Library**.

## Develop

```sh
uv run pytest -m "not live and not e2e"   # unit tests
uv run pytest -m e2e                      # WebKit end to end (first: uv run playwright install webkit)
uv run pytest -m live                     # needs music playing
uv run ruff check && uv run pyright
cd web && npm ci && npm test && npm run typecheck
```

On Linux, type-check with `uv run pyright -p pyrightconfig.linux.json`; Playwright's WebKit needs
Ubuntu's libraries (`playwright install --with-deps webkit` there, an Ubuntu container elsewhere).

Start with [AGENTS.md](AGENTS.md) (layout, commands, rules), then [docs/prd.md](docs/prd.md),
[docs/protocols.md](docs/protocols.md) and [NOTES.md](NOTES.md) (decisions and measurements).
Packaging as a standalone `.app` isn't built yet.
