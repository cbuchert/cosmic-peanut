"""Path safety for files served from a base directory."""

import os
from pathlib import Path

import pytest

from tidalviz.server.paths import resolve_under


@pytest.fixture
def base(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "sub").mkdir(parents=True)
    (root / "main.js").write_text("x")
    (root / "sub" / "a b.js").write_text("y")
    (tmp_path / "secret.txt").write_text("secret")
    return root


def test_plain_file(base: Path) -> None:
    assert resolve_under(base, "main.js") == (base / "main.js").resolve()


def test_nested_and_percent_encoded_name(base: Path) -> None:
    assert resolve_under(base, "sub/a%20b.js") == (base / "sub" / "a b.js").resolve()


@pytest.mark.parametrize(
    "raw",
    [
        "../secret.txt",
        "sub/../../secret.txt",
        "%2e%2e/secret.txt",
        "%2E%2E/secret.txt",
        "sub%2f..%2f..%2fsecret.txt",
        "..%2fsecret.txt",
        "/etc/passwd",
        "%2fetc%2fpasswd",
        "sub\\..\\..\\secret.txt",
        "sub%5c..%5csecret.txt",
        "main.js%00.png",
        "main.js\x00",
        "",
        "sub",  # directories are never listed
        "sub/",
        "./main.js",
        "sub//a%20b.js",
        ".git/config",
        "missing.js",
        "%zz",
    ],
)
def test_rejected(base: Path, raw: str) -> None:
    assert resolve_under(base, raw) is None


def test_symlink_escaping_base_is_rejected(base: Path) -> None:
    os.symlink(base.parent / "secret.txt", base / "link.txt")
    assert resolve_under(base, "link.txt") is None


def test_symlinked_dir_escaping_base_is_rejected(base: Path) -> None:
    os.symlink(base.parent, base / "up")
    assert resolve_under(base, "up/secret.txt") is None


def test_symlink_inside_base_is_allowed(base: Path) -> None:
    os.symlink(base / "main.js", base / "alias.js")
    assert resolve_under(base, "alias.js") == (base / "main.js").resolve()


def test_base_that_is_itself_a_symlink(base: Path, tmp_path: Path) -> None:
    os.symlink(base, tmp_path / "linked")
    assert resolve_under(tmp_path / "linked", "main.js") == (base / "main.js").resolve()
