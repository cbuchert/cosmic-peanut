"""The generated per-visualizer bootstrap page."""

import json
import re
from typing import Any

from tidalviz.server.bootstrap import bootstrap_html, script_json

HOSTILE = "</script><script>alert(1)</script>&amp;<!--  "


def _entry(**extra: Any) -> dict[str, Any]:
    return {"id": "bars", "name": "Bars", "entry": "src/main.js", "renderer": "2d", **extra}


def _boot_arg(html: str) -> dict[str, Any]:
    m = re.search(r"boot\((.*)\);", html)
    assert m is not None
    return json.loads(m.group(1))


def test_script_json_escapes_breakout_characters() -> None:
    out = script_json({"s": HOSTILE})
    for bad in ("<", ">", "&", " ", " "):
        assert bad not in out
    assert json.loads(out) == {"s": HOSTILE}


def test_page_boots_the_entry() -> None:
    html = bootstrap_html("builtin", "bars", _entry(), nonce="N0NCE")
    assert html.startswith("<!doctype html>")
    assert '<link rel="stylesheet" href="/sdk/bootstrap.css">' in html
    assert 'import { boot } from "/sdk/sdk.js";' in html
    assert _boot_arg(html) == {
        "key": "builtin/bars",
        "entry": "/r/builtin/src/main.js",
        "base": "/r/builtin/",
        "manifest": _entry(),
    }


def test_every_script_carries_the_nonce() -> None:
    html = bootstrap_html("builtin", "bars", _entry(libs=["three"]), nonce="N0NCE")
    scripts = re.findall(r"<script[^>]*>", html)
    assert len(scripts) == 2
    assert all('nonce="N0NCE"' in s for s in scripts)


def test_import_map_only_for_three() -> None:
    plain = bootstrap_html("builtin", "bars", _entry(), nonce="n")
    assert "importmap" not in plain
    three = bootstrap_html("builtin", "bars", _entry(libs=["three"]), nonce="n")
    m = re.search(r'<script type="importmap"[^>]*>(.*?)</script>', three)
    assert m is not None
    assert json.loads(m.group(1)) == {
        "imports": {"three": "/lib/three/three.module.js", "three/addons/": "/lib/three/addons/"}
    }


def test_hostile_manifest_strings_cannot_break_out() -> None:
    entry = _entry(name=HOSTILE, description=HOSTILE)
    html = bootstrap_html("builtin", "bars", entry, nonce="n")
    assert html.count("</script>") == 1  # only the module script's own closing tag
    assert "<script>" not in html
    assert " " not in html and " " not in html
    assert _boot_arg(html)["manifest"] == entry


def test_urls_are_percent_encoded() -> None:
    html = bootstrap_html("my repo", "bars", _entry(entry="src/a b.js"), nonce="n")
    arg = _boot_arg(html)
    assert arg["entry"] == "/r/my%20repo/src/a%20b.js"
    assert arg["base"] == "/r/my%20repo/"
    assert arg["key"] == "my repo/bars"
