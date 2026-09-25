"""Dev-only static server for the SDK browser harness (not shipped; see README.md here).

Mimics the host's plugin server routes (docs/protocols.md §3) closely enough to exercise the SDK:
  /                 -> harness.html (plays the shell)
  /sdk/<path>       -> web/sdk/*
  /lib/three/<path> -> web/node_modules/three/build/*
  /r/dev/<path>     -> web/sdk/dev/plugins/*
  /v/dev/<id>/      -> generated bootstrap page for visualizer <id> of plugins/tidalviz.json
Every response carries Access-Control-Allow-Origin: * (sandboxed iframes have opaque origins, so
their module loads are CORS requests). Usage: uv run python web/sdk/dev/serve.py [port]
"""

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEV = Path(__file__).resolve().parent
WEB = DEV.parent.parent
ROUTES = {
    "/sdk/": WEB / "sdk",
    "/lib/three/": WEB / "node_modules/three/build",
    "/r/dev/": DEV / "plugins",
}


def esc(o: object) -> str:
    """JSON-encode for inline <script>, escaping <, > and & like the host does."""
    return json.dumps(o).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def bootstrap(viz_id: str) -> bytes | None:
    manifest = json.loads((DEV / "plugins/tidalviz.json").read_text())
    entry = next((v for v in manifest["visualizers"] if v["id"] == viz_id), None)
    if entry is None:
        return None
    importmap = ""
    if "three" in entry.get("libs", []):
        importmap = (
            '<script type="importmap">{"imports":{"three":"/lib/three/three.module.js"}}</script>'
        )
    boot = {
        "key": f"dev/{viz_id}",
        "entry": f"/r/dev/{entry['entry']}",
        "base": "/r/dev/",
        "manifest": entry,
    }
    args = ", ".join(f"{k}: {esc(v)}" for k, v in boot.items())
    return (
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/sdk/bootstrap.css">'
        f'{importmap}<script type="module">import {{ boot }} from "/sdk/sdk.js"; boot({{ {args} }});</script>'
    ).encode()


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0]
        for prefix, root in ROUTES.items():
            if path.startswith(prefix):
                rel = path[len(prefix) :]
                if ".." in rel.split("/"):
                    return str(DEV / "__missing__")
                return str(root / rel)
        return str(DEV / "harness.html") if path == "/" else str(DEV / path.lstrip("/"))

    def do_GET(self) -> None:
        if self.path.startswith("/v/dev/"):
            page = bootstrap(self.path[len("/v/dev/") :].strip("/"))
            if page is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page)
            return
        super().do_GET()

    def log_message(self, format: str, *args: object) -> None:  # quiet
        pass


Handler.extensions_map = {
    **Handler.extensions_map,
    ".js": "text/javascript",
    ".mjs": "text/javascript",
}

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"http://127.0.0.1:{server.server_address[1]}/", flush=True)
    server.serve_forever()
