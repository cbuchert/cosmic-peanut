"""Watch dev folders with watchfiles on a background thread and report debounced changes."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from pathlib import Path

import watchfiles

from tidalviz.plugins.manifest import MANIFEST_NAME, ManifestError

log = logging.getLogger(__name__)

OnChange = Callable[[str, list[Path]], None]
OnManifestErrors = Callable[[str, list[ManifestError]], None]
Revalidate = Callable[[str], list[ManifestError]]


class DevFolderWatcher:
    """Calls `on_change(repo_key, changed_paths)` from a background thread after files change.

    When `tidalviz.json` changes and `revalidate` is given, the manifest is re-checked first:
    errors go to `on_manifest_errors` and no reload is signalled, so the last working version
    keeps running; the repo stays registered.
    """

    def __init__(
        self,
        on_change: OnChange,
        *,
        revalidate: Revalidate | None = None,
        on_manifest_errors: OnManifestErrors | None = None,
        debounce_ms: int = 50,
        step_ms: int = 10,
    ) -> None:
        self._on_change = on_change
        self._revalidate = revalidate
        self._on_manifest_errors = on_manifest_errors
        self._debounce_ms = debounce_ms
        self._step_ms = step_ms
        self._folders: dict[str, Path] = {}
        self._lock = threading.Lock()
        self._restart = threading.Event()  # folder set changed: rebuild the watcher
        self._stopping = False
        self._thread: threading.Thread | None = None

    @property
    def folders(self) -> dict[str, Path]:
        with self._lock:
            return dict(self._folders)

    def add(self, key: str, folder: Path) -> None:
        with self._lock:
            self._folders[key] = Path(os.path.realpath(folder))
        self._restart.set()

    def remove(self, key: str) -> None:
        with self._lock:
            removed = self._folders.pop(key, None)
        if removed is not None:
            self._restart.set()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="tidalviz-devwatch", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        thread, self._thread = self._thread, None
        if thread is None:
            return
        self._stopping = True
        self._restart.set()
        thread.join(timeout)
        if thread.is_alive():
            log.warning("dev-folder watcher didn't stop within %.1f s", timeout)

    # ---- worker thread --------------------------------------------------------------------

    def _run(self) -> None:
        while not self._stopping:
            self._restart.clear()
            folders = self.folders
            existing = [p for p in folders.values() if p.is_dir()]
            if not existing:
                self._restart.wait()
                continue
            try:
                for changes in watchfiles.watch(
                    *existing,
                    debounce=self._debounce_ms,
                    step=self._step_ms,
                    stop_event=self._restart,
                    raise_interrupt=False,
                    ignore_permission_denied=True,
                ):
                    self._dispatch(folders, {Path(p) for _, p in changes})
            except Exception:
                log.exception("dev-folder watcher failed; restarting")
                self._restart.wait(1.0)

    def _dispatch(self, folders: dict[str, Path], changed: set[Path]) -> None:
        by_repo: dict[str, list[Path]] = {}
        # Longest folder first so nested dev folders get their own changes.
        ordered = sorted(folders.items(), key=lambda kv: len(kv[1].parts), reverse=True)
        for path in changed:
            for key, folder in ordered:
                if path.is_relative_to(folder):
                    by_repo.setdefault(key, []).append(path)
                    break
        for key, paths in by_repo.items():
            with self._lock:
                if key not in self._folders:  # removed while the batch was in flight
                    continue
                folder = self._folders[key]
            paths.sort()
            try:
                if self._revalidate is not None and folder / MANIFEST_NAME in paths:
                    errors = self._revalidate(key)
                    if errors:
                        if self._on_manifest_errors is not None:
                            self._on_manifest_errors(key, errors)
                        continue
                self._on_change(key, paths)
            except Exception:
                log.exception("dev-folder callback for %s failed", key)
