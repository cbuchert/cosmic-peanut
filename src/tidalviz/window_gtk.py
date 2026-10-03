"""The pywebview/WebKitGTK window on Linux: the `WindowControl` pieces that differ from macOS.

GTK calls from other threads hop to the main loop with ``GLib.idle_add``. Keeping a window above
others is the compositor's job on Wayland (README → Linux).
"""
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportMissingTypeStubs=false, reportAttributeAccessIssue=false, reportPrivateImportUsage=false

import logging
import os
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

from tidalviz.window import PyWebviewWindow

log = logging.getLogger(__name__)


NVIDIA_DRIVER = Path("/proc/driver/nvidia/version")


def configure_gl_environment(
    environ: MutableMapping[str, str] = os.environ, *, nvidia_marker: Path = NVIDIA_DRIVER
) -> None:
    """Keep WebKitGTK alive on NVIDIA under native Wayland; call before GTK starts.

    Explicit sync crashes it on launch; disabling it keeps the DMA-BUF path (NOTES.md → Linux
    support). Only set when the NVIDIA driver is loaded; a value the user set wins.
    """
    if nvidia_marker.exists():
        environ.setdefault("__NV_DISABLE_EXPLICIT_SYNC", "1")


def _on_main(fn: Any) -> None:
    from gi.repository import GLib  # type: ignore[import-not-found]

    def run() -> bool:
        fn()
        return False  # run once

    GLib.idle_add(run)


class GtkWindow(PyWebviewWindow):
    """`WindowControl` for a pywebview GTK window."""

    def _webview(self) -> Any:
        from webview.platforms.gtk import BrowserView  # type: ignore[import-untyped]

        return BrowserView.instances[self.win.uid].webview

    def borderless(self) -> None:
        def go() -> None:
            self._borderless = not self._borderless
            self.win.native.set_decorated(not self._borderless)

        _on_main(go)

    def click_plugin(self) -> None:
        """One synthetic click into the web view (no pointer move) to lift WebKit's iframe
        rAF throttle. The shell ignores pointer events on the plugin iframe, so it's inert."""

        def go() -> None:
            from gi.repository import Gdk  # type: ignore[import-not-found]

            wv = self._webview()
            alloc = wv.get_allocation()
            seat = Gdk.Display.get_default().get_default_seat()
            for kind in (Gdk.EventType.BUTTON_PRESS, Gdk.EventType.BUTTON_RELEASE):
                ev = Gdk.Event.new(kind)
                ev.window = wv.get_window()
                ev.button = 1
                ev.x, ev.y = alloc.width / 2, alloc.height / 2
                ev.set_device(seat.get_pointer())
                wv.event(ev)

        _on_main(go)

    def recover_webview(self) -> None:
        """A hung plugin shares the shell's WebContent process; kill it, then reload."""

        def go() -> None:
            wv = self._webview()
            wv.terminate_web_process()
            wv.reload()

        _on_main(go)
