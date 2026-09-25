"""The generated bootstrap page for one visualizer (docs/protocols.md §3)."""

import json
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

_SCRIPT_ESCAPES = {
    ord("<"): "\\u003c",
    ord(">"): "\\u003e",
    ord("&"): "\\u0026",
    0x2028: "\\u2028",
    0x2029: "\\u2029",
}

_THREE_IMPORT_MAP = {
    "imports": {"three": "/lib/three/three.module.js", "three/addons/": "/lib/three/addons/"}
}


def script_json(value: Any) -> str:
    """JSON that is safe to embed inside a <script> element: no `<`, `>`, `&`, U+2028/2029."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False).translate(_SCRIPT_ESCAPES)


def bootstrap_html(repo_key: str, viz_id: str, entry: Mapping[str, Any], *, nonce: str) -> str:
    """The page served at /v/<repoKey>/<vizId>/. Every inline script carries ``nonce``."""
    base = f"/r/{quote(repo_key, safe='')}/"
    boot_arg = {
        "key": f"{repo_key}/{viz_id}",
        "entry": base + quote(str(entry["entry"]), safe="/"),
        "base": base,
        "manifest": dict(entry),
    }
    libs = entry.get("libs")
    import_map = ""
    if isinstance(libs, list) and "three" in libs:
        import_map = (
            f'<script type="importmap" nonce="{nonce}">{script_json(_THREE_IMPORT_MAP)}</script>\n'
        )
    return (
        '<!doctype html><meta charset="utf-8">\n'
        '<link rel="stylesheet" href="/sdk/bootstrap.css">\n'
        f"{import_map}"
        f'<script type="module" nonce="{nonce}">\n'
        '  import { boot } from "/sdk/sdk.js";\n'
        f"  boot({script_json(boot_arg)});\n"
        "</script>\n"
    )
