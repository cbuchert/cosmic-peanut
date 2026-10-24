"""Every built-in shader program compiles and links in WebKit's WebGL2 (ANGLE, as in the app).

Nothing else compiles GLSL before a visualizer runs: a stray `#endif` in an engine file passed the
unit suites. plugins/_harness/shader-programs.js lists every program variant the built-in packs
build (assembled with the visualizers' own splicing and `#define` helpers; its vitest checks no
shader file or visualizer is left out), and plugins/_harness/compile.html compiles each unique
source once. The three.js visualizers and the template run in the harness for a few frames.

    uv run pytest -m e2e tests/test_shader_compile.py
"""

import functools
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Browser, Page, sync_playwright

pytestmark = pytest.mark.e2e

ROOT = Path(__file__).resolve().parents[1]
# plugins/_harness/shader-programs.js IN_HARNESS, with the pack each lives in.
IN_HARNESS = {"tentacube": "builtin", "orbit": "builtin", "halo": "template"}


class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture(scope="module")
def base() -> Iterator[str]:
    """The repo root over HTTP on a free port (the harness's layout: /plugins, /web)."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def browser() -> Iterator[Browser]:
    with sync_playwright() as p:
        b = p.webkit.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser: Browser) -> Iterator[Page]:
    pg = browser.new_page(viewport={"width": 320, "height": 180})
    yield pg
    pg.close()


def test_every_builtin_shader_program_compiles_and_links(base: str, page: Page):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/plugins/_harness/compile.html")
    page.wait_for_function(
        "window.__result !== undefined || window.__errors.length > 0", timeout=120_000
    )
    assert not errors, errors
    r = page.evaluate("window.__result")
    assert r["setup"] is None, r["setup"]
    assert sorted(r["inHarness"]) == sorted(IN_HARNESS)
    assert r["programs"] > 100 and r["linked"] > 100, r
    failures: list[str] = r["failures"]
    names = "\n".join("  " + f.split("\n", 1)[0] for f in failures)
    head = f"{len(failures)} of {r['linked']} shader programs failed:\n{names}\n\n"
    assert not failures, head + "\n\n".join(failures)


@pytest.mark.parametrize("viz", sorted(IN_HARNESS))
def test_harness_visualizer_renders_without_shader_errors(base: str, page: Page, viz: str):
    console: list[str] = []
    page.on("console", lambda m: m.type == "error" and console.append(m.text))
    page.goto(f"{base}/plugins/_harness/index.html?repo={IN_HARNESS[viz]}&viz={viz}&still=3")
    page.wait_for_function("window.__still === true || window.__errors.length > 0", timeout=30_000)
    errors = page.evaluate("window.__errors") + console
    assert not errors, f"{viz}: {errors}"
