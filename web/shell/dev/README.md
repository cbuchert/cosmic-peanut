# Shell dev tools (not shipped)

- `mock_host.py` — fake host: serves the shell + `/config.json` + control WebSocket, a fake
  registry of two visualizers whose pages live on a second port (`fake_plugin.js` answers the
  §5 handshake, draws the bands, reports `ready`/`perf`/`onsetSeen`), and 94 Hz synthetic
  binary v1 frames. `uv run python web/shell/dev/mock_host.py` and open the printed URL.
  Test hooks: `GET /_log` (messages the shell sent), `POST /_send` (broadcast a host message).
  The Orbit visualizer's "Crash (test)" param makes the fake plugin report a fatal error.
- `e2e_check.py` — drives the shell against the mock in Playwright WebKit and asserts the main
  flows; measures `pluginHost.frame()` cost. `uv run python web/shell/dev/e2e_check.py --shots DIR`.
