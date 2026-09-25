"""Drive the shell against the mock host in Playwright WebKit (dev-only check, not shipped).

    uv run python web/shell/dev/e2e_check.py [--shots DIR]

Asserts: connect + hello renders the library, first launch notice, selection with crossfade,
params panel sends `params`, keys, a fatal plugin error falls back, heartbeat is sent,
permission help. Also measures shell per-frame overhead in the page and saves screenshots.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

from playwright.async_api import Page, async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mock_host import MockHost

BENCH_JS = """
async () => {
  const { createPluginHost } = await import('/shell/pluginHost.js');
  const box = document.createElement('div');
  document.body.append(box);
  const host = createPluginHost({
    container: box, onEvent() {}, visible: () => true,
    settings: { quality: 'auto', maxDpr: 2, fpsCap: 0, renderScaleMax: 1, reduceFlashing: true },
  });
  host.show({ key: 'bench/a', pageUrl: 'about:blank' }, {});
  await new Promise((r) => setTimeout(r, 300));
  const N = 5000;
  const bufs = Array.from({ length: N }, () => new ArrayBuffer(6496));
  let t0 = performance.now();
  for (let i = 0; i < N; i++) host.frame(bufs[i]);
  const single = (performance.now() - t0) / N;
  host.show({ key: 'bench/b', pageUrl: 'about:blank' }, {});
  await new Promise((r) => setTimeout(r, 300));
  const bufs2 = Array.from({ length: N }, () => new ArrayBuffer(6496));
  t0 = performance.now();
  for (let i = 0; i < N; i++) host.frame(bufs2[i]);
  const fade = (performance.now() - t0) / N;
  host.dispose();
  box.remove();
  return { single, fade };
}
"""


async def log(host: MockHost) -> list[dict[str, Any]]:
    return list(host.received)


def check(cond: bool, what: str) -> None:
    print(("PASS " if cond else "FAIL ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


async def wait_for(pred, timeout: float = 5.0) -> bool:  # type: ignore[no-untyped-def]
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.05)
    return False


async def wait_js(page: Page, expr: str, timeout: float = 5.0) -> None:
    """Poll a JS expression (wait_for_function needs eval, which the shell CSP forbids)."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if await page.evaluate(f"() => Boolean({expr})"):
            return
        await asyncio.sleep(0.05)
    raise SystemExit(f"FAIL timed out waiting for {expr}")


def sent(host: MockHost, type_: str) -> list[dict[str, Any]]:
    return [m for m in host.received if m.get("type") == type_]


async def run(shots: Path) -> None:
    shots.mkdir(parents=True, exist_ok=True)
    host = MockHost(0, 0)
    await host.start()
    try:
        async with async_playwright() as pw:
            browser = await pw.webkit.launch()
            page: Page = await browser.new_page(
                viewport={"width": 1280, "height": 760}, device_scale_factor=2
            )
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            await page.goto(host.url)

            await page.wait_for_selector("#library .card", state="attached")
            check(
                await page.locator("#library .card").count() == 2,
                "hello renders the library (2 cards)",
            )
            check(
                await page.locator("#notice").is_visible(), "first-launch photosensitivity notice"
            )
            await page.screenshot(path=str(shots / "01-notice.png"))
            await page.click("#notice button.primary")
            check(await wait_for(lambda: any(m.get("photosensitivityNoticeSeen") for m in sent(host, "settings"))),
                  "notice dismissal persisted via settings")  # fmt: skip

            check(
                await wait_for(lambda: bool(sent(host, "select"))),
                "first visualizer selected and persisted",
            )
            check(
                await page.locator(".now-name").text_content() == "Pulse Bars",
                "now playing shows Pulse Bars",
            )
            check(
                await wait_for(lambda: len(sent(host, "heartbeat")) >= 2, 3),
                "heartbeat sent every 500 ms",
            )
            check(
                await wait_for(lambda: bool(sent(host, "perf")), 4), "plugin perf forwarded to host"
            )
            perf = sent(host, "perf")[-1]
            check(
                isinstance(perf.get("shellMs"), (int, float)),
                f"perf carries shellMs ({perf.get('shellMs')})",
            )
            check(await wait_for(lambda: bool(sent(host, "onsetSeen")), 4), "onsetSeen forwarded")
            iframe = page.locator("iframe.viz-frame")
            check(
                await iframe.get_attribute("sandbox") == "allow-scripts",
                "iframe sandbox is allow-scripts only",
            )
            await page.mouse.move(640, 380)
            await page.screenshot(path=str(shots / "02-player.png"))

            # --- switch with crossfade ---
            await page.keyboard.press("n")
            check(await wait_for(lambda: any(m.get("key") == "mock/orbit" for m in sent(host, "select"))),
                  "N selects the next visualizer")  # fmt: skip
            await wait_js(page, "document.querySelectorAll('iframe.viz-frame').length === 2")
            await wait_js(
                page,
                "[...document.querySelectorAll('iframe.viz-frame')].some(f => f.style.opacity === '1')"
                " && document.querySelectorAll('iframe.viz-frame').length === 2",
            )
            await page.wait_for_timeout(700)
            ops = await page.evaluate(
                "[...document.querySelectorAll('iframe.viz-frame')].map(f => getComputedStyle(f).opacity)"
            )
            check(
                len(ops) == 2 and all(0 < float(o) < 1 for o in ops),
                f"mid-crossfade both visible {ops}",
            )
            await wait_js(page, "document.querySelectorAll('iframe.viz-frame').length === 1", 4.0)
            check(True, "old iframe removed after 1.5 s crossfade")
            check(
                await page.locator(".now-name").text_content() == "Orbit", "now playing shows Orbit"
            )

            # --- params panel ---
            await page.mouse.move(600, 300)
            await page.click("button[title='Parameters']")
            await page.wait_for_selector("#params:not([hidden])")
            await page.locator("#param-hue").evaluate(
                "el => { el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); }"
            )
            check(await wait_for(lambda: any(m.get("values", {}).get("hue") == 120 for m in sent(host, "params"))),
                  "params panel sends full params")  # fmt: skip
            p = [m for m in sent(host, "params") if m.get("values", {}).get("hue") == 120][-1]
            check(
                set(p["values"]) == {"hue", "shape", "tint", "crash"},
                f"params are the full set {p['values']}",
            )
            await page.screenshot(path=str(shots / "03-params.png"))
            await page.keyboard.press("Escape")
            check(await page.locator("#params").is_hidden(), "Esc closes the panel")

            # --- keys ---
            await page.keyboard.press("l")
            check(await page.locator("#library").is_visible(), "L opens library")
            await page.screenshot(path=str(shots / "04-library.png"))
            await page.keyboard.press("Escape")
            check(await page.locator("#library").is_hidden(), "Esc closes library")
            await page.keyboard.press("p")
            check(await page.locator("#hud").is_visible(), "P shows HUD")
            await host.broadcast({"type": "stats", "hostCpu": 4.2, "rssMb": 88, "analysisMsP50": 0.3,
                                  "captureToSendMsP95": 3.1, "droppedFrames": 0, "latencyMsP95": 28})  # fmt: skip
            await page.wait_for_timeout(1300)
            check(
                "4.2%" in (await page.locator("#hud").text_content() or ""), "HUD shows host stats"
            )
            await page.keyboard.press("f")
            await page.keyboard.press("t")
            acts = [m["action"] for m in sent(host, "window")]
            check(acts[-2:] == ["fullscreen", "floatOnTop"], f"F/T send window actions {acts}")
            await page.keyboard.press("Shift+N")
            check(
                await wait_for(lambda: sent(host, "select")[-1]["key"] == "mock/bars"),
                "Shift+N goes back",
            )
            await page.wait_for_timeout(1800)
            await page.keyboard.press("n")
            check(
                await wait_for(lambda: sent(host, "select")[-1]["key"] == "mock/orbit"),
                "N again to Orbit",
            )
            await wait_js(page, "document.querySelectorAll('iframe.viz-frame').length === 1", 5.0)

            # --- idle fade ---
            await page.wait_for_timeout(3300)
            check(await page.evaluate("document.getElementById('app').classList.contains('idle')"),
                  "overlays fade after 3 s idle")  # fmt: skip
            await page.screenshot(path=str(shots / "05-idle.png"))
            await page.mouse.move(100, 100)
            await page.mouse.move(120, 120)
            check(not await page.evaluate("document.getElementById('app').classList.contains('idle')"),
                  "mouse movement brings overlays back")  # fmt: skip

            # --- fatal error falls back ---
            await page.click("button[title='Parameters']")
            await page.click("#param-crash")  # panel re-renders on fallback
            check(await wait_for(lambda: any(m.get("fatal") for m in sent(host, "pluginError"))),
                  "fatal plugin error reported to host")  # fmt: skip
            check(await wait_for(lambda: sent(host, "select")[-1]["key"] == "mock/bars"),
                  "fell back to the previous visualizer")  # fmt: skip
            await page.wait_for_selector("#error:not([hidden])")
            txt = await page.locator("#error").text_content() or ""
            check(
                "fake_plugin.js:42: Crash requested" in txt,
                "error overlay shows file:line: message",
            )
            await page.keyboard.press("Escape")
            await page.screenshot(path=str(shots / "06-fatal.png"))

            # --- permission help ---
            await host.broadcast({"type": "silence", "silent": True, "seconds": 4})
            await page.wait_for_selector("#permission:not([hidden])")
            await page.click("#permission button")
            check(
                await wait_for(lambda: bool(sent(host, "openPermissions"))),
                "permission button sends openPermissions",
            )

            # --- install prompt ---
            await page.keyboard.press("l")
            await page.fill("#add-url", "https://github.com/x/y")
            await page.keyboard.press("Enter")
            await page.wait_for_selector("#install:not([hidden])")
            await page.screenshot(path=str(shots / "07-install.png"))
            await page.click("#install button.primary")
            check(await wait_for(lambda: any(m.get("accept") for m in sent(host, "installConfirm"))),
                  "trust prompt confirm sends installConfirm")  # fmt: skip

            # --- overhead ---
            bench = await page.evaluate(BENCH_JS)
            print(f"shell frame() cost: {bench['single'] * 1000:.1f} µs/frame, "
                  f"{bench['fade'] * 1000:.1f} µs/frame during crossfade", flush=True)  # fmt: skip
            check(bench["fade"] < 1.0, "shell overhead < 1 ms per frame")

            real_errors = [e for e in errors if "favicon" not in e]
            check(not real_errors, f"no page errors {real_errors}")
            await browser.close()
    finally:
        await host.stop()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", type=Path, default=Path("/tmp/tidalviz-shell-shots"))
    asyncio.run(run(ap.parse_args().shots))
