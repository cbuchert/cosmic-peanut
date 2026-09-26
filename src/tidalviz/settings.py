"""User settings persisted as JSON in the app support dir (docs/protocols.md §4 `settings`)."""

import copy
import json
import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast

from tidalviz.plugins.store import atomic_write_json

QUALITY_MODES = ("auto", "high", "balanced", "battery")

DEFAULTS: dict[str, Any] = {
    "quality": "auto",
    "reduceFlashing": True,
    "autoCycleSeconds": 0,
    "hudVisible": False,
    "photosensitivityNoticeSeen": False,
    "active": None,
    "source": "system",
    "params": {},
    "window": None,
    "transparent": True,  # show the desktop behind the visual
    "borderless": True,  # no title bar or window chrome
}


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _is_window(v: Any) -> bool:
    if v is None:
        return True
    if not isinstance(v, dict):
        return False
    w = cast(dict[str, Any], v)
    return all(type(w.get(k)) is int for k in ("x", "y", "width", "height"))


# Keys the shell or host may set, each with its validator. `params` has its own setter.
_VALID: dict[str, Callable[[Any], bool]] = {
    "quality": lambda v: v in QUALITY_MODES,
    "reduceFlashing": _is_bool,
    "autoCycleSeconds": lambda v: type(v) is int and 0 <= v <= 3600,
    "hudVisible": _is_bool,
    "photosensitivityNoticeSeen": _is_bool,
    "active": lambda v: v is None or (isinstance(v, str) and 0 < len(v) <= 200),
    "source": lambda v: isinstance(v, str) and 0 < len(v) <= 200,
    "window": _is_window,
    "transparent": _is_bool,
    "borderless": _is_bool,
}


class Settings:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict[str, Any] = copy.deepcopy(DEFAULTS)
        try:
            loaded: Any = json.loads(path.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            os.replace(path, path.with_name(f"{path.name}.corrupt-{int(time.time() * 1000)}"))
            return
        if not isinstance(loaded, dict):
            return
        doc = cast(dict[str, Any], loaded)
        self._apply(doc)
        params = doc.get("params")
        if isinstance(params, dict):
            items = cast(dict[Any, Any], params).items()
            self.data["params"] = {
                k: v for k, v in items if isinstance(k, str) and isinstance(v, dict)
            }

    def _apply(self, partial: Mapping[str, Any]) -> dict[str, Any]:
        changed: dict[str, Any] = {}
        for key, value in partial.items():
            valid = _VALID.get(key)
            if valid is not None and valid(value) and self.data[key] != value:
                self.data[key] = value
                changed[key] = value
        return changed

    def update(self, partial: Mapping[str, Any]) -> dict[str, Any]:
        """Apply the valid, known keys; persist; return what actually changed."""
        changed = self._apply(partial)
        if changed:
            self.save()
        return changed

    def params_for(self, key: str) -> dict[str, Any]:
        return dict(self.data["params"].get(key, {}))

    def set_params(self, key: str, values: Mapping[str, Any]) -> None:
        self.data["params"][key] = dict(values)
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.path, self.data)
