"""registry.json: installed repos, dev folders and disabled visualizers. Atomic, corruption-proof."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

REGISTRY_VERSION = 1


def atomic_write_json(path: Path, obj: Any) -> None:
    """Write JSON to a temp file in the same directory, fsync, then `os.replace` over `path`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@dataclass(slots=True)
class RepoRecord:
    """One installed git repo."""

    key: str
    url: str
    ref: str | None
    commit: str
    previous: str | None = None
    installed_at: float | None = None
    checked_at: float | None = None
    update: dict[str, str] | None = None  # {commit, message} found by the last update check

    def to_json(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "ref": self.ref,
            "commit": self.commit,
            "previous": self.previous,
            "installedAt": self.installed_at,
            "checkedAt": self.checked_at,
            "update": self.update,
        }

    @classmethod
    def from_json(cls, key: str, d: Any) -> RepoRecord:
        if not isinstance(d, dict):
            raise ValueError(f"repo {key!r} is not an object")
        rec: dict[str, Any] = d  # pyright: ignore[reportUnknownVariableType]
        url, ref, commit, previous = (rec.get(k) for k in ("url", "ref", "commit", "previous"))
        if not isinstance(url, str) or not isinstance(commit, str):
            raise ValueError(f"repo {key!r} needs url and commit strings")
        if not (ref is None or isinstance(ref, str)) or not (
            previous is None or isinstance(previous, str)
        ):
            raise ValueError(f"repo {key!r} has a bad ref/previous")
        update = rec.get("update")
        if update is not None and not (
            isinstance(update, dict)
            and all(isinstance(update.get(k), str) for k in ("commit", "message"))  # pyright: ignore[reportUnknownMemberType]
        ):
            raise ValueError(f"repo {key!r} has a bad update")
        return cls(
            key=key,
            url=url,
            ref=ref,
            commit=commit,
            previous=previous,
            installed_at=_opt_float(rec.get("installedAt")),
            checked_at=_opt_float(rec.get("checkedAt")),
            update=update,  # pyright: ignore[reportUnknownArgumentType]
        )


def _opt_float(x: object) -> float | None:
    if x is None:
        return None
    if isinstance(x, int | float) and not isinstance(x, bool):
        return float(x)
    raise ValueError(f"expected a number, got {x!r}")


@dataclass(slots=True)
class RegistryData:
    repos: dict[str, RepoRecord] = field(default_factory=dict[str, RepoRecord])
    dev_folders: list[str] = field(default_factory=list[str])
    disabled: set[str] = field(default_factory=set[str])

    def to_json(self) -> dict[str, Any]:
        return {
            "version": REGISTRY_VERSION,
            "repos": {k: r.to_json() for k, r in sorted(self.repos.items())},
            "devFolders": list(self.dev_folders),
            "disabled": sorted(self.disabled),
        }

    @classmethod
    def from_json(cls, d: Any) -> RegistryData:
        if not isinstance(d, dict):
            raise ValueError("registry is not an object")
        obj: dict[str, Any] = d  # pyright: ignore[reportUnknownVariableType]
        repos, dev, disabled = (
            obj.get("repos", {}),
            obj.get("devFolders", []),
            obj.get("disabled", []),
        )
        if (
            not isinstance(repos, dict)
            or not isinstance(dev, list)
            or not isinstance(disabled, list)
        ):
            raise ValueError("registry has the wrong shape")
        repo_items: dict[str, Any] = repos  # pyright: ignore[reportUnknownVariableType]
        dev_items: list[Any] = dev  # pyright: ignore[reportUnknownVariableType]
        disabled_items: list[Any] = disabled  # pyright: ignore[reportUnknownVariableType]
        if not all(isinstance(x, str) for x in [*dev_items, *disabled_items]):
            raise ValueError("devFolders and disabled must be strings")
        return cls(
            repos={k: RepoRecord.from_json(k, v) for k, v in repo_items.items()},
            dev_folders=list(dev_items),
            disabled=set(disabled_items),
        )


class RegistryFile:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> RegistryData:
        """Read the registry. A corrupt file is renamed aside and an empty registry returned."""
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return RegistryData()
        try:
            return RegistryData.from_json(json.loads(raw.decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as e:
            backup = self.path.with_name(f"{self.path.name}.corrupt-{int(time.time() * 1000)}")
            os.replace(self.path, backup)
            log.warning("registry.json was corrupt (%s); moved it to %s", e, backup.name)
            return RegistryData()

    def save(self, data: RegistryData) -> None:
        atomic_write_json(self.path, data.to_json())
