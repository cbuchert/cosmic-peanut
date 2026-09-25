"""The read-only view of the plugin registry that the servers depend on."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol


class RegistryView(Protocol):
    def repo_dir(self, repo_key: str) -> Path | None:
        """The registered plugin directory for a repo, or None if unknown."""
        ...

    def entry(self, repo_key: str, viz_id: str) -> Mapping[str, Any] | None:
        """The validated manifest entry dict for one visualizer, or None if unknown."""
        ...

    def is_dev(self, repo_key: str) -> bool:
        """True for dev folders (served with Cache-Control: no-store)."""
        ...
