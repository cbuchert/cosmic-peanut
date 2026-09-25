"""Where Tidalviz keeps its data (settings, registry, installed plugins, cache)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def default_root() -> Path:
    """`~/Library/Application Support/Tidalviz`, or `$TIDALVIZ_HOME` when set (tests, dev)."""
    env = os.environ.get("TIDALVIZ_HOME")
    if env:
        return Path(env)
    return Path.home() / "Library" / "Application Support" / "Tidalviz"


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
