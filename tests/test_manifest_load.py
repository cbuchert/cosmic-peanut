"""load_manifest: reads tidalviz.json from a repo dir and checks referenced files exist inside it."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tidalviz.plugins.manifest import load_manifest


def write_repo(root: Path, manifest: Any, files: dict[str, str] | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "tidalviz.json").write_text(
        manifest if isinstance(manifest, str) else json.dumps(manifest)
    )
    for rel, text in (files or {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    return root


def manifest(**viz: Any) -> dict[str, Any]:
    v = {"id": "pulse", "name": "Pulse", "entry": "src/main.js", "renderer": "2d"}
    v.update(viz)
    return {"apiVersion": 1, "visualizers": [v]}


def test_valid_repo_loads(tmp_path: Path) -> None:
    repo = write_repo(tmp_path / "r", manifest(thumbnail="t.png"), {"src/main.js": "", "t.png": ""})
    result = load_manifest(repo)
    assert result.errors == []
    assert result.manifest is not None
    assert result.manifest["visualizers"][0]["id"] == "pulse"


def test_missing_manifest(tmp_path: Path) -> None:
    tmp_path.joinpath("r").mkdir()
    result = load_manifest(tmp_path / "r")
    assert result.manifest is None
    assert [e.path for e in result.errors] == ["tidalviz.json"]
    assert "not found" in result.errors[0].message


def test_invalid_json_reports_line(tmp_path: Path) -> None:
    repo = write_repo(tmp_path / "r", '{\n  "apiVersion": 1,\n  oops\n}')
    result = load_manifest(repo)
    assert result.manifest is None
    assert result.errors[0].path == "tidalviz.json"
    assert "line 3" in result.errors[0].message


def test_missing_entry_and_thumbnail(tmp_path: Path) -> None:
    repo = write_repo(tmp_path / "r", manifest(thumbnail="t.png"))
    result = load_manifest(repo)
    assert [(e.path, e.message) for e in result.errors] == [
        ("visualizers[0].entry", "file not found: src/main.js"),
        ("visualizers[0].thumbnail", "file not found: t.png"),
    ]


def test_entry_is_directory(tmp_path: Path) -> None:
    repo = write_repo(tmp_path / "r", manifest(entry="src"), {"src/x.js": ""})
    assert [e.path for e in load_manifest(repo).errors] == ["visualizers[0].entry"]


def test_symlink_escaping_repo_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "secret.js").write_text("")
    repo = write_repo(tmp_path / "r", manifest(entry="src/main.js"))
    (repo / "src").mkdir()
    (repo / "src" / "main.js").symlink_to(tmp_path / "secret.js")
    errors = load_manifest(repo).errors
    assert [e.path for e in errors] == ["visualizers[0].entry"]
    assert "outside" in errors[0].message


def test_symlinked_dir_escaping_repo_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "elsewhere" / "main.js").write_text("")
    repo = write_repo(tmp_path / "r", manifest(entry="src/main.js"))
    (repo / "src").symlink_to(tmp_path / "elsewhere")
    assert "outside" in load_manifest(repo).errors[0].message


def test_schema_errors_skip_file_checks(tmp_path: Path) -> None:
    repo = write_repo(tmp_path / "r", manifest(entry="../x.js"))
    errors = load_manifest(repo).errors
    assert [e.path for e in errors] == ["visualizers[0].entry"]
    assert "relative path" in errors[0].message
