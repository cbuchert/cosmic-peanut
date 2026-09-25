"""The pywebview/WKWebView window: native glue for `WindowControl` (tools/spike/REPORT.md).

Thin platform code, verified by running the app and the e2e suite rather than unit tests.
"""
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportMissingTypeStubs=false, reportAttributeAccessIssue=false, reportPrivateImportUsage=false

import logging
from typing import Any

log = logging.getLogger(__name__)


def patch_webkit(*, features: dict[str, bool]) -> None:
    """Make pywebview's WKWebViewConfiguration set WebKit feature flags (no hook exists)."""
    import WebKit  # type: ignore[import-not-found]
    from webview.platforms import cocoa  # type: ignore[import-not-found]

    real = WebKit

    class _Config:
        @staticmethod
        def alloc() -> "_Config":
            return _Config()

        def init(self) -> Any:
            c = real.WKWebViewConfiguration.alloc().init()
            for f in real.WKPreferences._features():
                if str(f.key()) in features:
                    c.preferences()._setEnabled_forFeature_(features[str(f.key())], f)
            return c

    class _Proxy:
        WKWebViewConfiguration = _Config

        def __getattr__(self, name: str) -> Any:
            return getattr(real, name)

    cocoa.WebKit = _Proxy()


def _on_main(fn: Any) -> None:
    from PyObjCTools import AppHelper  # type: ignore[import-not-found]

    AppHelper.callAfter(fn)


class PyWebviewWindow:
    """`WindowControl` for a pywebview window. Every native call hops to the main thread."""

    def __init__(self) -> None:
        self.win: Any = None
        self._borderless = False

    def attach(self, win: Any) -> None:
        self.win = win

    def _webview(self) -> Any:
        import WebKit  # type: ignore[import-not-found]

        view = self.win.native.contentView()
        if isinstance(view, WebKit.WKWebView):
            return view
        return next(v for v in view.subviews() if isinstance(v, WebKit.WKWebView))

    def fullscreen(self) -> None:
        # An on-top window ignores the first fullscreen toggle (spike); drop on-top first.
        if self.win.on_top:
            self.win.on_top = False
        self.win.toggle_fullscreen()

    def float_on_top(self) -> None:
        self.win.on_top = not self.win.on_top

    def borderless(self) -> None:
        import AppKit  # type: ignore[import-not-found]

        def go() -> None:
            w = self.win.native
            self._borderless = not self._borderless
            full = AppKit.NSWindowStyleMaskFullSizeContentView
            mask = w.styleMask()
            w.setStyleMask_(mask | full if self._borderless else mask & ~full)
            w.setTitlebarAppearsTransparent_(self._borderless)
            w.setTitleVisibility_(1 if self._borderless else 0)  # NSWindowTitleHidden
            w.setMovableByWindowBackground_(self._borderless)
            for button in (0, 1, 2):  # close, minimize, zoom
                b = w.standardWindowButton_(button)
                if b is not None:
                    b.setHidden_(self._borderless)

        _on_main(go)

    def quit(self) -> None:
        self.win.destroy()

    def click_plugin(self) -> None:
        """One synthetic click into the web view (no cursor move) to lift WebKit's iframe
        rAF throttle. The shell ignores pointer events on the plugin iframe, so it's inert."""
        import AppKit  # type: ignore[import-not-found]

        def go() -> None:
            w = self.win.native
            wv = self._webview()
            b = wv.bounds()
            pt = wv.convertPoint_toView_(
                AppKit.NSMakePoint(b.size.width / 2, b.size.height / 2), None
            )
            t = AppKit.NSProcessInfo.processInfo().systemUptime()
            for kind in (AppKit.NSEventTypeLeftMouseDown, AppKit.NSEventTypeLeftMouseUp):
                ev = AppKit.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
                    kind, pt, 0, t, w.windowNumber(), None, 0, 1, 1.0
                )
                w.sendEvent_(ev)

        _on_main(go)

    def recover_webview(self) -> None:
        """A hung plugin shares the shell's WebContent process; only kill-and-reset recovers."""

        def go() -> None:
            wv = self._webview()
            try:
                wv._killWebContentProcessAndResetState()
            except Exception:
                log.exception("kill-and-reset failed; sending SIGKILL")
                import os
                import signal

                os.kill(int(wv._webProcessIdentifier()), signal.SIGKILL)
            wv.reload()

        _on_main(go)

    def pick_folder(self) -> str | None:
        import webview  # type: ignore[import-not-found]

        result = self.win.create_file_dialog(webview.FileDialog.FOLDER)
        return str(result[0]) if result else None
