"""Shallow, limit-enforced git fetches with dulwich (pure Python, no system git)."""

from __future__ import annotations

import os
import posixpath
import re
import shutil
import stat
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import urllib3
from dulwich.client import GitClient, LocalGitClient, get_transport_and_path
from dulwich.errors import NotGitRepository
from dulwich.object_store import iter_tree_contents, peel_sha
from dulwich.objects import S_ISGITLINK, Blob, Commit, ObjectID
from dulwich.refs import Ref
from dulwich.repo import Repo

Transport = Callable[[str], tuple[GitClient, str]]
"""Maps a repo URL to a dulwich client and the path to pass it (injectable for tests)."""

_SHA = re.compile(r"^[0-9a-f]{40}$")
_LFS_MAGIC = b"version https://git-lfs.github.com/spec/v1"


class FetchError(Exception):
    """A fetch failed; str() is a user-facing reason."""


class LimitError(FetchError):
    """The repo breaks a safety limit (size, file count, escaping symlink, unsafe path)."""


@dataclass(frozen=True, slots=True)
class FetchLimits:
    max_bytes: int = 200 * 1024 * 1024
    max_files: int = 5000
    timeout_s: float = 60.0


@dataclass(slots=True)
class FetchResult:
    commit: str
    message: str  # first line of the commit message
    checkout: Path  # plain files, no .git
    warnings: list[str] = field(default_factory=list[str])
    object_count: int = 0
    temp_dir: Path | None = None  # owns `checkout`; remove with discard()

    def discard(self) -> None:
        if self.temp_dir is not None:
            shutil.rmtree(self.temp_dir, ignore_errors=True)


def default_transport(timeout_s: float = 60.0) -> Transport:
    """HTTPS via urllib3 with connect/read timeouts."""
    pool = urllib3.PoolManager(timeout=urllib3.Timeout(connect=15.0, read=timeout_s))

    def transport(url: str) -> tuple[GitClient, str]:
        return get_transport_and_path(url, thin_packs=False, pool_manager=pool)

    return transport


def local_transport(repos: Mapping[str, Path]) -> Transport:
    """Serve the given URLs from local repos (tests, fixtures). Unknown URLs fail to fetch."""

    def transport(url: str) -> tuple[GitClient, str]:
        path = repos.get(url)
        if path is None:
            raise FetchError(f"can't reach {url}")
        return LocalGitClient(thin_packs=False), str(path)

    return transport


def _format_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.0f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} bytes"


def _first_line(message: bytes) -> str:
    return message.decode("utf-8", "replace").strip().split("\n", 1)[0].strip()


def _run_with_timeout[T](fn: Callable[[], T], timeout_s: float, what: str) -> T:
    """Run blocking network I/O in a worker so a stalled server can't hang the caller."""
    box: dict[str, Any] = {}

    def work() -> None:
        try:
            box["value"] = fn()
        except BaseException as e:
            box["error"] = e

    t = threading.Thread(target=work, name="tidalviz-git", daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        raise FetchError(f"{what} timed out after {timeout_s:.0f} s")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _resolve_ref(
    refs: Mapping[Ref, ObjectID | None], symrefs: Mapping[Ref, Ref], ref: str | None
) -> bytes:
    if ref is None:
        target = symrefs.get(Ref(b"HEAD"))
        sha = refs.get(target) if target else refs.get(Ref(b"HEAD"))
        if not sha:
            raise FetchError("the remote has no default branch")
        return bytes(sha)
    if _SHA.match(ref):
        return ref.encode()
    name = ref.encode()
    for candidate in (b"refs/heads/" + name, b"refs/tags/" + name, name):
        sha = refs.get(Ref(candidate))
        if sha:
            return bytes(sha)
    raise FetchError(f"ref {ref!r} not found on the remote")


def _check_path(path: str) -> None:
    parts = path.split("/")
    if path.startswith("/") or any(p in ("", ".", "..", ".git") for p in parts) or "\\" in path:
        raise LimitError(f"unsafe path in repo: {path!r}")


def _check_symlink(path: str, target: bytes) -> str:
    text = target.decode("utf-8", "replace")
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(path), text))
    if text.startswith("/") or joined == ".." or joined.startswith("../") or "\0" in text:
        raise LimitError(f"symlink {path} points outside the repo")
    return text


class GitFetcher:
    """Fetches one ref at depth 1 into a temp dir under `cache_dir` and checks it out as plain files."""

    def __init__(
        self,
        cache_dir: Path,
        *,
        transport: Transport | None = None,
        limits: FetchLimits | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.limits = limits or FetchLimits()
        self._transport = transport or default_transport(self.limits.timeout_s)

    def fetch(self, url: str, ref: str | None) -> FetchResult:
        """Fetch `ref` (None = default branch). The caller owns the result; call discard() or move it."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix="fetch-", dir=self.cache_dir))
        deadline = time.monotonic() + self.limits.timeout_s
        try:
            repo, commit, count = self._fetch_objects(url, ref, temp / "objects")
            checkout = temp / "checkout"
            try:
                warnings = self._checkout(repo, commit, checkout, deadline)
            except OSError as e:
                raise FetchError(f"can't check out {url}: {e.strerror or e}") from e
            repo.close()
            shutil.rmtree(temp / "objects", ignore_errors=True)
            return FetchResult(
                commit=commit.id.decode(),
                message=_first_line(commit.message),
                checkout=checkout,
                warnings=warnings,
                object_count=count,
                temp_dir=temp,
            )
        except BaseException:
            shutil.rmtree(temp, ignore_errors=True)
            raise

    def remote_head(self, url: str, ref: str | None) -> tuple[str, str]:
        """(commit SHA, first line of its message) that `ref` currently points to on the remote."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix="check-", dir=self.cache_dir))
        try:
            repo, commit, _ = self._fetch_objects(url, ref, temp / "objects")
            repo.close()
            return commit.id.decode(), _first_line(commit.message)
        finally:
            shutil.rmtree(temp, ignore_errors=True)

    def _fetch_objects(self, url: str, ref: str | None, dest: Path) -> tuple[Repo, Commit, int]:
        dest.mkdir(parents=True)
        target = Repo.init_bare(str(dest))
        limit = self.limits.max_bytes

        def network() -> tuple[Repo, Commit, int]:
            try:
                client, path = self._transport(url)
                remote = client.get_refs(path.encode())
                want = _resolve_ref(remote.refs, remote.symrefs, ref)
                f, commit_pack, abort = target.object_store.add_pack()
                received = 0

                def write(data: bytes) -> int:
                    nonlocal received
                    received += len(data)
                    if received > limit:
                        raise LimitError(f"repo is larger than {_format_bytes(limit)}")
                    return f.write(data)

                try:
                    result = client.fetch_pack(
                        path,
                        lambda refs, depth=None: [ObjectID(want)],  # pyright: ignore[reportUnknownLambdaType]
                        target.get_graph_walker(),
                        write,
                        depth=1,
                    )
                except BaseException:
                    abort()
                    raise
                commit_pack()
                target.update_shallow(result.new_shallow, result.new_unshallow)
            except FetchError:
                raise
            except (NotGitRepository, KeyError) as e:
                raise FetchError(f"can't fetch {url}: {e or 'not found'}") from e
            except Exception as e:
                raise FetchError(f"can't fetch {url}: {e}") from e
            try:
                _, obj = peel_sha(target.object_store, ObjectID(want))
            except KeyError as e:
                raise FetchError(f"the remote didn't send {want.decode()}") from e
            if not isinstance(obj, Commit):
                raise FetchError(f"ref {ref!r} doesn't point to a commit")
            return target, obj, len(list(target.object_store))

        try:
            return _run_with_timeout(network, self.limits.timeout_s, f"fetching {url}")
        except BaseException:
            target.close()
            raise

    def _checkout(self, repo: Repo, commit: Commit, dest: Path, deadline: float) -> list[str]:
        warnings: list[str] = []
        links: list[tuple[str, str]] = []
        files = total = 0
        # macOS file systems are case-insensitive: two entries that differ only in case would
        # silently overwrite each other (or let a symlink stand in for a directory).
        seen_files: set[str] = set()
        seen_dirs: set[str] = set()
        store = repo.object_store
        dest.mkdir()
        for entry in iter_tree_contents(store, commit.tree):
            if time.monotonic() > deadline:
                raise FetchError(f"checkout timed out after {self.limits.timeout_s:.0f} s")
            path = entry.path.decode("utf-8", "replace")
            _check_path(path)
            folded = path.casefold()
            prefixes = ["/".join(folded.split("/")[:i]) for i in range(1, folded.count("/") + 1)]
            if (
                folded in seen_files
                or folded in seen_dirs
                or any(d in seen_files for d in prefixes)
            ):
                raise LimitError(f"paths differ only in case: {path}")
            seen_files.add(folded)
            seen_dirs.update(prefixes)
            mode = entry.mode
            if S_ISGITLINK(mode):
                warnings.append(f"Ignored git submodule {path}")
                continue
            files += 1
            if files > self.limits.max_files:
                raise LimitError(f"repo has more than {self.limits.max_files} files")
            blob = store[entry.sha]
            assert isinstance(blob, Blob)
            data = blob.as_raw_string()
            total += len(data)
            if total > self.limits.max_bytes:
                raise LimitError(f"repo is larger than {_format_bytes(self.limits.max_bytes)}")
            if stat.S_ISLNK(mode):
                links.append((path, _check_symlink(path, data)))
                continue
            if len(data) < 1024 and data.startswith(_LFS_MAGIC):
                warnings.append(f"Ignored Git LFS file {path} (LFS isn't supported)")
                continue
            out = dest / path
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            if mode & 0o111:
                out.chmod(0o755)
        # Symlinks last, so no regular file is ever written through one.
        for path, target in links:
            out = dest / path
            out.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(target, out)
        root = dest.resolve()
        for path, _ in links:
            if not (dest / path).resolve().is_relative_to(root):
                raise LimitError(f"symlink {path} points outside the repo")
        return warnings
