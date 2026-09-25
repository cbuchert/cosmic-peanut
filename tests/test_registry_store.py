"""App paths, atomic JSON writes and registry.json persistence/corruption handling."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tidalviz.paths import AppPaths, default_root
from tidalviz.plugins.store import RegistryFile, RepoRecord, atomic_write_json


def test_default_root_is_application_support(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TIDALVIZ_HOME", raising=False)
    assert default_root() == Path.home() / "Library" / "Application Support" / "Tidalviz"


def test_root_can_be_overridden_by_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TIDALVIZ_HOME", str(tmp_path))
    assert default_root() == tmp_path


def test_app_paths_layout(tmp_path: Path) -> None:
    p = AppPaths(tmp_path)
    assert p.settings == tmp_path / "settings.json"
    assert p.registry == tmp_path / "registry.json"
    assert p.plugins == tmp_path / "plugins"
    assert p.cache == tmp_path / "cache"


def test_atomic_write_replaces_and_leaves_no_temp(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    atomic_write_json(target, {"a": 1})
    atomic_write_json(target, {"a": 2})
    assert json.loads(target.read_text()) == {"a": 2}
    assert [p.name for p in tmp_path.iterdir()] == ["x.json"]


def test_atomic_write_failure_keeps_old_file(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    atomic_write_json(target, {"a": 1})
    with pytest.raises(TypeError):
        atomic_write_json(target, {"a": object()})
    assert json.loads(target.read_text()) == {"a": 1}
    assert [p.name for p in tmp_path.iterdir()] == ["x.json"]


def test_registry_roundtrip(tmp_path: Path) -> None:
    f = RegistryFile(tmp_path / "registry.json")
    data = f.load()
    assert data.repos == {} and data.dev_folders == [] and data.disabled == set()
    data.repos["k"] = RepoRecord(
        key="k",
        url="https://example.com/a/b",
        ref="v1",
        commit="c" * 40,
        previous="p" * 40,
        installed_at=1.5,
        checked_at=2.5,
        update={"commit": "d" * 40, "message": "new"},
    )
    data.dev_folders.append("/tmp/viz")
    data.disabled.add("k/pulse")
    f.save(data)
    again = RegistryFile(tmp_path / "registry.json").load()
    assert again == data


@pytest.mark.parametrize(
    "content", ["{not json", "[]", '{"repos": 3}', '{"repos": {"k": {"url": 5}}}', "\x00\x01"]
)
def test_corrupt_registry_is_backed_up_and_starts_empty(tmp_path: Path, content: str) -> None:
    path = tmp_path / "registry.json"
    path.write_text(content)
    data = RegistryFile(path).load()
    assert data.repos == {}
    backups = list(tmp_path.glob("registry.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_text() == content


def test_unknown_fields_are_tolerated(tmp_path: Path) -> None:
    path = tmp_path / "registry.json"
    path.write_text(
        json.dumps({"version": 1, "future": True, "repos": {}, "devFolders": [], "disabled": []})
    )
    assert RegistryFile(path).load().repos == {}
    assert not list(tmp_path.glob("*.corrupt-*"))
