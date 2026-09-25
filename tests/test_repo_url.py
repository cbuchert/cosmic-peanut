"""parse_repo_url: accepted inputs, rejections, and collision-free keys."""

from __future__ import annotations

import hashlib
import re

import pytest

from tidalviz.plugins.repo_url import RepoUrlError, parse_repo_url

OK = [
    # (input, url, ref, display)
    ("owner/repo", "https://github.com/owner/repo", None, "owner/repo"),
    ("owner/repo#v1.2.0", "https://github.com/owner/repo", "v1.2.0", "owner/repo#v1.2.0"),
    ("https://github.com/owner/repo", "https://github.com/owner/repo", None, "owner/repo"),
    ("https://github.com/owner/repo.git", "https://github.com/owner/repo", None, "owner/repo"),
    ("https://github.com/owner/repo/", "https://github.com/owner/repo", None, "owner/repo"),
    ("https://GitHub.com/Owner/Repo", "https://github.com/Owner/Repo", None, "Owner/Repo"),
    ("  owner/repo  ", "https://github.com/owner/repo", None, "owner/repo"),
    (
        "https://gitlab.com/g/sub/repo.git#main",
        "https://gitlab.com/g/sub/repo",
        "main",
        "gitlab.com/g/sub/repo#main",
    ),
    (
        "https://codeberg.org/a/b#feature/x",
        "https://codeberg.org/a/b",
        "feature/x",
        "codeberg.org/a/b#feature/x",
    ),
    (
        "https://git.example.com:8443/a/b",
        "https://git.example.com:8443/a/b",
        None,
        "git.example.com:8443/a/b",
    ),
    (
        "my.org/re_po-2#0123456789abcdef0123456789abcdef01234567",
        "https://github.com/my.org/re_po-2",
        "0123456789abcdef0123456789abcdef01234567",
        "my.org/re_po-2#0123456",
    ),
]


@pytest.mark.parametrize(("text", "url", "ref", "display"), OK)
def test_accepts(text: str, url: str, ref: str | None, display: str) -> None:
    spec = parse_repo_url(text)
    assert (spec.url, spec.ref, spec.display) == (url, ref, display)


BAD = [
    ("", "empty"),
    ("git@github.com:owner/repo.git", "ssh"),
    ("ssh://git@github.com/owner/repo", "ssh"),
    ("http://github.com/owner/repo", "https"),
    ("file:///Users/me/repo", "https"),
    ("ftp://host/a/b", "https"),
    ("https://user:pass@github.com/owner/repo", "credentials"),
    ("https://token@github.com/owner/repo", "credentials"),
    ("https://github.com/owner/repo?x=1", "query"),
    ("https://github.com/own er/repo", "whitespace"),
    ("owner/repo #main", "whitespace"),
    ("https://github.com/owner", "owner/repo"),
    ("https://github.com/", "owner/repo"),
    ("repo", "owner/repo"),
    ("github.com/owner/repo", "https://"),
    ("owner/repo#", "ref"),
    ("owner/repo#a..b", "ref"),
    ("owner/repo#-rf", "ref"),
    ("owner/repo#a#b", "ref"),
    ("https://github.com/../etc/x", "owner/repo"),
    ("https://github.com/a/./b", "owner/repo"),
    ("https:///a/b", "host"),
]


@pytest.mark.parametrize(("text", "fragment"), BAD)
def test_rejects(text: str, fragment: str) -> None:
    with pytest.raises(RepoUrlError) as exc:
        parse_repo_url(text)
    assert fragment.lower() in str(exc.value).lower()


def test_key_is_readable_slug_plus_url_hash() -> None:
    spec = parse_repo_url("https://github.com/Owner/My_Viz.git")
    digest = hashlib.sha256(b"https://github.com/owner/my_viz").hexdigest()[:8]
    assert spec.key == f"github-com-owner-my-viz-{digest}"


def test_key_ignores_ref_and_spelling() -> None:
    keys = {
        parse_repo_url(t).key
        for t in [
            "owner/repo",
            "owner/repo#v2",
            "https://github.com/owner/repo.git",
            "https://github.com/OWNER/repo/",
        ]
    }
    assert len(keys) == 1


def test_forks_and_lookalikes_never_collide() -> None:
    a = parse_repo_url("https://github.com/a-b/c").key
    b = parse_repo_url("https://github.com/a/b-c").key
    assert a != b
    assert a.rsplit("-", 1)[0] == b.rsplit("-", 1)[0]  # same slug, different hash


@pytest.mark.parametrize(
    "text",
    [t for t, *_ in OK] + ["https://ünïcode.example/ä/ö", "https://github.com/" + "x" * 300 + "/y"],
)
def test_keys_are_url_path_safe(text: str) -> None:
    key = parse_repo_url(text).key
    assert re.fullmatch(r"[a-z0-9-]+", key)
    assert len(key) <= 80
