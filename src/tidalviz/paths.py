"""Where Tidalviz keeps its data (settings, registry, installed plugins, cache)."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


def default_root() -> Path:
    """`~/Library/Application Support/Tidalviz` on macOS, `$XDG_DATA_HOME/Tidalviz` (default
    `~/.local/share`) elsewhere, or `$TIDALVIZ_HOME` when set (tests, dev)."""
    env = os.environ.get("TIDALVIZ_HOME")
    if env:
        return Path(env)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Tidalviz"
    xdg = os.environ.get("XDG_DATA_HOME", "")
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / ".local" / "share"
    return base / "Tidalviz"


@dataclass(frozen=True, slots=True)
class AppPaths:
    root: Path

    @property
    def settings(self) -> Path:
        return self.root / "settings.json"

    @property
    def registry(self) -> Path:
        return self.root / "registry.json"

    @property
    def plugins(self) -> Path:
        return self.root / "plugins"

    @property
    def cache(self) -> Path:
        return self.root / "cache"
