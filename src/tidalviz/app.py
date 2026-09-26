"""Entry point: `uv run tidalviz [--dev PATH] [--source ID] [--bench KEY --seconds N]`.

Threads (PRD): Cocoa/pywebview on the main thread, the asyncio loop (servers, control) on its
own thread, plus the pipeline's capture and analysis threads.
"""

import argparse
import asyncio
import json
import logging
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from tidalviz.paths import default_root

if TYPE_CHECKING:
    from tidalviz.host import Host
    from tidalviz.window import PyWebviewWindow

log = logging.getLogger("tidalviz")

APP_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))


def builtin_dirs() -> list[Path]:
    plugins = APP_ROOT / "plugins"
    return [plugins / "builtin", plugins / "cosmic-peanut", plugins / "template"]


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="tidalviz", description=__doc__)
    p.add_argument("--dev", type=Path, help="plugin folder to hot-reload (enables Web Inspector)")
    p.add_argument("--source", help="system | app:<pid> | synthetic:<kind> (this launch only)")
    p.add_argument("--bench", metavar="KEY", help="benchmark a visualizer and write a report")
    p.add_argument("--seconds", type=int, default=60, help="benchmark length")
    p.add_argument("--out", type=Path, default=Path("bench.json"), help="benchmark report path")
    p.add_argument("--home", type=Path, help="data dir (default: ~/Library/Application Support)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    import webview  # type: ignore[import-untyped]

    from tidalviz.host import Host
    from tidalviz.window import PyWebviewWindow

    dev = args.dev is not None
    window = PyWebviewWindow()
    host = Host(
        root=args.home or default_root(),
        builtin_dirs=builtin_dirs(),
        window=window,
        source_id=args.source,
        dev=dev,
        bench_key=args.bench,
    )
    if args.dev is not None:
        host.use_dev_folder(args.dev)

    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, name="tidalviz-asyncio", daemon=True).start()
    asyncio.run_coroutine_threadsafe(host.start(), loop).result(timeout=10)
    log.info("shell %s  plugins %s", host.servers.shell_origin, host.servers.plugin_origin)

    win = webview.create_window(  # pyright: ignore[reportUnknownMemberType]
        "Tidalviz",
        host.servers.shell_url,
        width=1280,
        height=720,
        min_size=(320, 180),
        background_color="#000000",
    )
    window.attach(win)
    if args.bench is not None:
        threading.Thread(target=_finish_bench, args=(host, window, args), daemon=True).start()
    try:
        webview.start(debug=dev)  # pyright: ignore[reportUnknownMemberType]
    finally:
        asyncio.run_coroutine_threadsafe(host.stop(), loop).result(timeout=10)
        loop.call_soon_threadsafe(loop.stop)


def _finish_bench(host: "Host", window: "PyWebviewWindow", args: argparse.Namespace) -> None:
    import time

    time.sleep(args.seconds)
    assert host.bench is not None
    report = host.bench.report()
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    log.info("bench report written to %s: %s", args.out, report)
    window.quit()


if __name__ == "__main__":
    main()
