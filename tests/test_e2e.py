"""End to end: Playwright WebKit drives the real shell, SDK and plugins against a real host.

The host runs the synthetic source, so results are repeatable. WebKit throttles a never-clicked
cross-origin iframe to 20 Hz (tools/spike/REPORT.md), so each test clicks the stage, as the
app's native click does.

    uv run pytest -m e2e
"""

import asyncio
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from playwright.sync_api import Page, sync_playwright

from tests.test_host import BUILTINS, FakeWindow, write_dev_plugin
from tidalviz.host import Host

pytestmark = pytest.mark.e2e


class RunningHost:
    """A Host on its own event-loop thread (the app's layout), recording shell messages."""

    def __init__(self, root: Path) -> None:
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.host = Host(
            root=root, builtin_dirs=BUILTINS, source_id="synthetic:demo", window=FakeWindow()
        )
        self.seen: list[dict[str, Any]] = []
        handler = self.host._on_message  # pyright: ignore[reportPrivateUsage]

        def record(client: Any, msg: dict[str, Any]) -> None:
            self.seen.append(msg)
            handler(client, msg)

        self.host.servers.control._on_message = record  # pyright: ignore[reportPrivateUsage]

    def run(self, coro: Any) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=10)

    def last(self, type_: str) -> dict[str, Any] | None:
        return next((m for m in reversed(self.seen) if m["type"] == type_), None)


@pytest.fixture
def running(tmp_path: Path) -> Iterator[RunningHost]:
    rh = RunningHost(tmp_path / "home")
    yield rh
    rh.run(rh.host.stop())
    rh.loop.call_soon_threadsafe(rh.loop.stop)


@pytest.fixture
def page() -> Iterator[Page]:
    with sync_playwright() as p:
        browser = p.webkit.launch()
        pg = browser.new_page(viewport={"width": 1280, "height": 720})
        yield pg
        browser.close()


def open_shell(rh: RunningHost, page: Page) -> None:
    rh.run(rh.host.start())
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(rh.host.servers.shell_url)
    page.wait_for_selector("#stage iframe", timeout=10_000)
    # Once the plugin reports its (throttled) rate the shell lets a click through to it.
    page.get_by_role("button", name="Got it").click()  # first-launch photosensitivity notice
    wait_for(page, lambda: rh.last("perf") is not None)
    page.mouse.click(640, 360)
    assert not errors, errors


def wait_for(page: Page, cond: Any, timeout_ms: int = 8000) -> None:
    for _ in range(timeout_ms // 100):
        if cond():
            return
        page.wait_for_timeout(100)  # never time.sleep: it stalls the page (spike)
    raise AssertionError("condition not met in time")


def test_loads_the_active_visualizer_and_renders_at_display_rate(running: RunningHost, page: Page):
    open_shell(running, page)
    wait_for(page, lambda: (p := running.last("perf")) is not None and p["fps"] >= 50)
    perf = running.last("perf")
    assert perf is not None and perf["key"] == running.host.settings.data["active"]


def test_next_key_switches_and_persists_the_selection(running: RunningHost, page: Page):
    open_shell(running, page)
    wait_for(page, lambda: running.host.settings.data["active"] is not None)
    before = running.host.settings.data["active"]
    page.keyboard.press("n")
    wait_for(page, lambda: running.host.settings.data["active"] != before)
    after = running.host.settings.data["active"]
    wait_for(page, lambda: (p := running.last("perf")) is not None and p["key"] == after)


def test_parameter_changes_reach_the_host(running: RunningHost, page: Page):
    open_shell(running, page)
    wait_for(page, lambda: running.last("perf") is not None)
    page.get_by_role("button", name="Parameters").click()
    first = page.locator("#params input[type=range]").first
    first.focus()
    page.keyboard.press("ArrowRight")
    wait_for(page, lambda: running.last("params") is not None)
    key = running.host.settings.data["active"]
    assert running.host.settings.params_for(key)


def test_hot_reload_swaps_in_the_edited_plugin(running: RunningHost, page: Page, tmp_path: Path):
    folder = tmp_path / "live"
    write_dev_plugin(folder)
    main = folder / "src" / "main.js"
    main.write_text('document.title = "version 1";\nexport default () => ({ frame() {} });\n')
    key = running.host.use_dev_folder(folder)
    open_shell(running, page)
    wait_for(page, lambda: (p := running.last("perf")) is not None and p["key"] == key)
    assert any(f.title() == "version 1" for f in page.frames[1:])
    page.wait_for_timeout(300)  # let the watcher settle
    main.write_text('document.title = "version 2";\nexport default () => ({ frame() {} });\n')
    # The shell loads the edited plugin in a fresh iframe and swaps it in once ready.
    wait_for(page, lambda: any(f.title() == "version 2" for f in page.frames[1:]))
