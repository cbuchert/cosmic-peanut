"""GitFetcher against local fixture repos built with dulwich (no network, no system git)."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest
from dulwich import porcelain
from dulwich.objects import Blob, Commit, Tree
from dulwich.repo import Repo

from tidalviz.plugins.git import FetchError, FetchLimits, GitFetcher, LimitError, local_transport

AUTHOR = b"Fixture <fixture@example.com>"


def manifest_json(*ids: str) -> str:
    vizs = [{"id": i, "name": i.title(), "entry": f"src/{i}.js", "renderer": "2d"} for i in ids]
    return json.dumps({"apiVersion": 1, "visualizers": vizs})


def plugin_files(*ids: str) -> dict[str, str]:
    return {"tidalviz.json": manifest_json(*ids), **{f"src/{i}.js": f"// {i}\n" for i in ids}}


def commit_files(repo_dir: Path, files: dict[str, str | bytes], message: str = "commit") -> str:
    """Write files into a worktree (creating the repo if needed) and commit them. Returns SHA."""
    if not (repo_dir / ".git").exists():
        porcelain.init(str(repo_dir))
    for rel, content in files.items():
        p = repo_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content)
    porcelain.add(str(repo_dir), [str(repo_dir / rel) for rel in files])
    sha = porcelain.commit(str(repo_dir), message=message, author=AUTHOR, committer=AUTHOR)
    return sha.decode()


def commit_tree(repo_dir: Path, entries: dict[str, tuple[int, bytes]], message: str = "raw") -> str:
    """Commit an arbitrary flat-or-nested tree on the current branch; value = (mode, blob data or gitlink sha)."""
    repo = Repo(str(repo_dir))
    store = repo.object_store

    def build(items: dict[str, Any]) -> bytes:
        tree = Tree()
        for name, val in items.items():
            if isinstance(val, dict):
                tree.add(name.encode(), stat.S_IFDIR, build(val))
            else:
                mode, data = val
                if mode == 0o160000:
                    tree.add(name.encode(), mode, data)
                else:
                    blob = Blob.from_string(data)
                    store.add_object(blob)
                    tree.add(name.encode(), mode, blob.id)
        store.add_object(tree)
        return tree.id

    nested: dict[str, Any] = {}
    for path, val in entries.items():
        *dirs, leaf = path.split("/")
        node = nested
        for d in dirs:
            node = node.setdefault(d, {})
        node[leaf] = val
    c = Commit()
    c.tree = build(nested)
    try:
        c.parents = [repo.refs[b"HEAD"]]
    except KeyError:
        c.parents = []
    c.author = c.committer = AUTHOR
    c.author_time = c.commit_time = 1_700_000_000
    c.author_timezone = c.commit_timezone = 0
    c.message = message.encode()
    store.add_object(c)
    repo.refs[b"HEAD"] = c.id
    return c.id.decode()


def plugin_entries(*ids: str) -> dict[str, tuple[int, bytes]]:
    return {rel: (0o100644, text.encode()) for rel, text in plugin_files(*ids).items()}


URL = "https://example.com/me/viz"


@pytest.fixture
def origin(tmp_path: Path) -> Path:
    return tmp_path / "origin"


@pytest.fixture
def fetcher(tmp_path: Path, origin: Path) -> GitFetcher:
    return GitFetcher(tmp_path / "cache", transport=local_transport({URL: origin}))


def test_fetch_default_branch(fetcher: GitFetcher, origin: Path) -> None:
    commit_files(origin, plugin_files("a"), "first")
    sha = commit_files(origin, {"src/a.js": "// v2\n"}, "second\n\nbody")
    result = fetcher.fetch(URL, None)
    assert result.commit == sha
    assert result.message == "second"
    assert (result.checkout / "src/a.js").read_text() == "// v2\n"
    assert (result.checkout / "tidalviz.json").is_file()
    assert not (result.checkout / ".git").exists()
    assert result.warnings == []
    assert result.checkout.is_relative_to(fetcher.cache_dir)


def test_fetch_is_shallow(fetcher: GitFetcher, origin: Path) -> None:
    commit_files(origin, plugin_files("a"), "first")
    commit_files(origin, {"big-old.bin": b"x" * 10}, "second")
    commit_files(origin, {"src/a.js": "// 3\n"}, "third")
    result = fetcher.fetch(URL, None)
    assert result.object_count <= 8  # 1 commit + trees + blobs of the tip only


def test_fetch_tag_ref(fetcher: GitFetcher, origin: Path) -> None:
    v1 = commit_files(origin, plugin_files("a"), "v1")
    porcelain.tag_create(str(origin), "v1.0.0", author=AUTHOR, message="release", annotated=True)
    porcelain.tag_create(str(origin), "light", objectish=v1)
    commit_files(origin, {"src/a.js": "// later\n"}, "later")
    assert fetcher.fetch(URL, "v1.0.0").commit == v1
    assert fetcher.fetch(URL, "light").commit == v1


def test_fetch_branch_ref(fetcher: GitFetcher, origin: Path) -> None:
    commit_files(origin, plugin_files("a"), "main")
    porcelain.branch_create(str(origin), "dev")
    porcelain.checkout(str(origin), "dev")
    dev = commit_files(origin, {"src/a.js": "// dev\n"}, "on dev")
    porcelain.checkout(str(origin), "master")
    assert fetcher.fetch(URL, "dev").commit == dev
    assert fetcher.fetch(URL, None).commit != dev


def test_fetch_commit_ref(fetcher: GitFetcher, origin: Path) -> None:
    first = commit_files(origin, plugin_files("a"), "first")
    commit_files(origin, {"src/a.js": "// 2\n"}, "second")
    result = fetcher.fetch(URL, first)
    assert result.commit == first
    assert (result.checkout / "src/a.js").read_text() == "// a\n"


def test_unknown_ref(fetcher: GitFetcher, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    with pytest.raises(FetchError, match="nope"):
        fetcher.fetch(URL, "nope")


def test_unreachable_repo(tmp_path: Path) -> None:
    f = GitFetcher(tmp_path / "cache", transport=local_transport({}))
    with pytest.raises(FetchError):
        f.fetch(URL, None)
    assert list((tmp_path / "cache").glob("*")) == []


def test_remote_head(fetcher: GitFetcher, origin: Path) -> None:
    sha = commit_files(origin, plugin_files("a"), "tip message")
    assert fetcher.remote_head(URL, None) == (sha, "tip message")


def test_too_many_files(tmp_path: Path, origin: Path) -> None:
    commit_files(origin, {**plugin_files("a"), **{f"f/{i}.txt": "" for i in range(10)}})
    f = GitFetcher(
        tmp_path / "cache",
        transport=local_transport({URL: origin}),
        limits=FetchLimits(max_files=5),
    )
    with pytest.raises(LimitError, match="5 files"):
        f.fetch(URL, None)
    assert list((tmp_path / "cache").glob("*")) == []


def test_too_big(tmp_path: Path, origin: Path) -> None:
    commit_files(origin, {**plugin_files("a"), "big.bin": os.urandom(64 * 1024)})
    f = GitFetcher(
        tmp_path / "cache",
        transport=local_transport({URL: origin}),
        limits=FetchLimits(max_bytes=32 * 1024),
    )
    with pytest.raises(LimitError, match="larger than 32 KB"):
        f.fetch(URL, None)
    assert list((tmp_path / "cache").glob("*")) == []


ESCAPES: list[dict[str, bytes]] = [
    {"src/link": b"../../etc/passwd"},
    {"src/link": b"/etc/passwd"},
    {"src/link": b"./../.."},
    # Each link is lexically inside, but the chain resolves above the root.
    {"p/q/d2": b"../..", "p/q/x": b"d2/../.."},
]


@pytest.mark.parametrize("links", ESCAPES)
def test_escaping_symlink_is_rejected(
    fetcher: GitFetcher, origin: Path, links: dict[str, bytes]
) -> None:
    porcelain.init(str(origin))
    commit_tree(origin, {**plugin_entries("a"), **{k: (0o120000, v) for k, v in links.items()}})
    with pytest.raises(LimitError, match="symlink"):
        fetcher.fetch(URL, None)
    assert list(fetcher.cache_dir.glob("*")) == []


def test_internal_symlink_is_kept(fetcher: GitFetcher, origin: Path) -> None:
    porcelain.init(str(origin))
    commit_tree(
        origin,
        {**plugin_entries("a"), "src/alias.js": (0o120000, b"a.js"), "top": (0o120000, b"src")},
    )
    result = fetcher.fetch(URL, None)
    assert os.readlink(result.checkout / "src/alias.js") == "a.js"
    assert (result.checkout / "top" / "a.js").read_text() == "// a\n"


def test_submodule_and_lfs_are_skipped_with_warnings(fetcher: GitFetcher, origin: Path) -> None:
    porcelain.init(str(origin))
    lfs = b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n"
    commit_tree(
        origin,
        {
            **plugin_entries("a"),
            "vendor/lib": (0o160000, b"a" * 40),
            "assets/tex.png": (0o100644, lfs),
        },
    )
    result = fetcher.fetch(URL, None)
    assert not (result.checkout / "vendor/lib").exists()
    assert not (result.checkout / "assets/tex.png").exists()
    assert any("submodule" in w and "vendor/lib" in w for w in result.warnings)
    assert any("LFS" in w and "assets/tex.png" in w for w in result.warnings)


def test_executable_bit_and_nested_dirs(fetcher: GitFetcher, origin: Path) -> None:
    porcelain.init(str(origin))
    commit_tree(origin, {**plugin_entries("a"), "tools/run.sh": (0o100755, b"#!/bin/sh\n")})
    result = fetcher.fetch(URL, None)
    assert (result.checkout / "tools/run.sh").stat().st_mode & 0o100


@pytest.mark.parametrize("bad", [".git/config", "a/.git/hooks/x", "..", "a/../b"])
def test_unsafe_tree_paths_rejected(fetcher: GitFetcher, origin: Path, bad: str) -> None:
    porcelain.init(str(origin))
    repo = Repo(str(origin))
    blob = Blob.from_string(b"x")
    repo.object_store.add_object(blob)
    # Build trees by hand so the bad name survives.
    parts = bad.split("/")
    child_id, child_mode = blob.id, 0o100644
    for name in reversed(parts):
        t = Tree()
        t.add(name.encode(), child_mode, child_id)
        repo.object_store.add_object(t)
        child_id, child_mode = t.id, stat.S_IFDIR
    c = Commit()
    c.tree = child_id
    c.author = c.committer = AUTHOR
    c.author_time = c.commit_time = 1_700_000_000
    c.author_timezone = c.commit_timezone = 0
    c.message = b"evil"
    repo.object_store.add_object(c)
    repo.refs[b"HEAD"] = c.id
    with pytest.raises(LimitError, match="unsafe path"):
        fetcher.fetch(URL, None)


def test_discard_removes_temp(fetcher: GitFetcher, origin: Path) -> None:
    commit_files(origin, plugin_files("a"))
    result = fetcher.fetch(URL, None)
    result.discard()
    assert not result.checkout.exists()
    assert list(fetcher.cache_dir.glob("*")) == []


def test_too_big_after_decompression(tmp_path: Path, origin: Path) -> None:
    commit_files(origin, {**plugin_files("a"), "zeros.bin": b"\0" * (256 * 1024)})
    f = GitFetcher(
        tmp_path / "cache",
        transport=local_transport({URL: origin}),
        limits=FetchLimits(max_bytes=64 * 1024),
    )
    with pytest.raises(LimitError, match="larger than 64 KB"):
        f.fetch(URL, None)


def test_timeout(tmp_path: Path) -> None:
    import threading

    from dulwich.client import LocalGitClient

    release = threading.Event()

    class Stalled(LocalGitClient):
        def get_refs(self, *args: Any, **kwargs: Any) -> Any:
            release.wait(5)
            raise ConnectionError("gave up")

    f = GitFetcher(
        tmp_path / "cache",
        transport=lambda url: (Stalled(), "x"),
        limits=FetchLimits(timeout_s=0.2),
    )
    try:
        with pytest.raises(FetchError, match="timed out"):
            f.fetch(URL, None)
    finally:
        release.set()


def test_case_colliding_paths_rejected(fetcher: GitFetcher, origin: Path) -> None:
    porcelain.init(str(origin))
    commit_tree(
        origin, {**plugin_entries("a"), "X/evil.js": (0o100644, b"x"), "x": (0o120000, b"src")}
    )
    with pytest.raises(LimitError, match="case"):
        fetcher.fetch(URL, None)
    assert list(fetcher.cache_dir.glob("*")) == []
