# Tidalviz — guide for agents and developers

Tidalviz captures macOS system audio, analyzes it in Python, and drives sandboxed web visualizer
plugins in a WKWebView. The PRD is the source of truth for product scope; these docs are the
source of truth for contracts:

| Doc | What it pins down |
| --- | --- |
| [`docs/plugin-api.md`](docs/plugin-api.md) | The public visualizer API: manifest, entry module, `ctx`, `audio`, lifecycle |
| [`web/sdk/tidalviz.d.ts`](web/sdk/tidalviz.d.ts) | The same API as TypeScript declarations (authoritative types) |
| [`src/tidalviz/plugins/manifest.schema.json`](src/tidalviz/plugins/manifest.schema.json) | Manifest JSON Schema |
| [`docs/protocols.md`](docs/protocols.md) | Internal contracts: binary frame, control WebSocket, shell↔plugin MessagePort, HTTP routes, Python interfaces |
| [`NOTES.md`](NOTES.md) | Decisions and measured numbers, per milestone |

Change a contract only by editing its doc in the same commit as the code, and keep both sides'
tests green (the golden frame fixture in `tests/fixtures/` is shared by pytest and vitest).

## Commands

Python (uv only — no pip, venvs, or make):

```sh
uv sync                                   # install everything (dev group is default)
uv run pytest -m "not live and not e2e"   # fast unit suite (includes perf checks)
uv run pytest -m perf                     # wall-clock checks only (non-blocking in CI)
uv run pytest -m live                     # needs real audio playing + capture permission
uv run pytest -m e2e                      # Playwright/WebKit end to end
uv run ruff check && uv run ruff format --check
uv run pyright
uv run tidalviz --dev <plugin folder>     # run from source, Web Inspector on
```

Web (Node is a dev-time tool only; the shell and SDK are plain ES modules with JSDoc types, so
the runtime never needs a build step):

```sh
cd web && npm ci
npm test            # vitest (SDK + shell units, golden frame decode)
npm run typecheck   # tsc --checkJs, strict
```

## Layout

```
src/tidalviz/   capture/ analysis/ transport/ server/ plugins/ app.py
web/sdk/        runs inside each plugin iframe (sdk.js, tidalviz.d.ts)
web/shell/      host UI in the main WKWebView document
web/vendor/     vendored, pinned third-party code (three.js)
plugins/        built-in visualizers, same format as installed ones
tests/          pytest; tests/fixtures/ shared with web tests
tools/          task scripts, run with `uv run python -m tools.<name>`
```

## Rules

- Test-first: one failing test, watch it fail for the right reason, minimum code, green, refactor.
- Hot paths allocate nothing per frame (Python: preallocated numpy, index ring buffer, no
  `np.roll`; JS: reusable typed-array views). Every stage keeps only the newest frame.
- Plugins are untrusted. Never render plugin-supplied strings as HTML; validate every message.
