"""PluginRegistry: every visualizer repo the host knows about (built-in, installed from git, dev).

Thread-safe: the asyncio thread reads it while the dev-folder watcher reloads. Network work
(`prepare_install`, `update`, `check_updates`) blocks, so callers run it in an executor.
"""

from __future__ import annotations

import logging
import os
import secrets
import shutil
import stat
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tidalviz.paths import AppPaths
from tidalviz.plugins.git import FetchResult, GitFetcher
from tidalviz.plugins.manifest import ManifestError, load_manifest
from tidalviz.plugins.repo_url import RepoSpec, RepoUrlError, hash8, parse_repo_url, slugify
from tidalviz.plugins.store import RegistryData, RegistryFile, RepoRecord

log = logging.getLogger(__name__)

UPDATE_CHECK_INTERVAL_S = 24 * 3600


class InstallError(Exception):
    """An install/update/rollback/remove request can't proceed; str() is user-facing."""


class ManifestInvalid(InstallError):
    """The repo's tidalviz.json (or the files it names) failed validation."""

    def __init__(self, errors: list[ManifestError]) -> None:
        super().__init__("; ".join(f"{e.path}: {e.message}" for e in errors[:5]))
        self.errors = errors


@dataclass(slots=True)
class PendingInstall:
    """A fetched and validated checkout waiting for the user's trust decision."""

    id: str
    spec: RepoSpec
    commit: str
    message: str
    visualizers: list[dict[str, str]]  # [{id, name}] for the trust prompt
    temp_dir: Path  # the checkout; deleted on cancel, moved into the store on confirm
    warnings: list[str] = field(default_factory=list[str])
    fetch_result: FetchResult | None = field(default=None, repr=False)


@dataclass(slots=True)
class _Repo:
    key: str
    dir: Path
    kind: str  # "builtin" | "git" | "dev"
    manifest: dict[str, Any] | None = None  # last valid manifest
    errors: list[ManifestError] = field(default_factory=list[ManifestError])


def _make_read_only(root: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath, name)
            if not p.is_symlink():
                mode = p.stat().st_mode
                p.chmod(0o555 if mode & stat.S_IXUSR else 0o444)
        for name in dirnames:
            p = Path(dirpath, name)
            if not p.is_symlink():
                p.chmod(0o555)
    root.chmod(0o555)


def _rmtree_read_only(root: Path) -> None:
    """Delete a read-only store dir (dirs need +w before their entries can be unlinked)."""
    if not root.exists() and not root.is_symlink():
        return
    for dirpath, dirnames, _ in os.walk(root):
        for name in dirnames:
            p = Path(dirpath, name)
            if not p.is_symlink():
                p.chmod(0o755)
    root.chmod(0o755)
    shutil.rmtree(root)


def dev_key(path: Path) -> str:
    """`dev-<slug of folder name>-<hash8 of absolute path>`."""
    abs_path = path.resolve()
    return f"dev-{slugify(abs_path.name, 40)}-{hash8(str(abs_path))}"


class PluginRegistry:
    """Built-in, installed and dev-folder visualizer repos, plus the install/update workflow."""

    def __init__(
        self,
        root: Path,
        builtin_dirs: Sequence[Path] = (),
        *,
        fetcher: GitFetcher | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.paths = AppPaths(root)
        self._file = RegistryFile(self.paths.registry)
        self._fetcher = fetcher or GitFetcher(self.paths.cache)
        self._clock = clock
        self._lock = threading.RLock()
        self._pending: dict[str, PendingInstall] = {}
        self._repos: dict[str, _Repo] = {}
        self._clean_cache()
        self._data: RegistryData = self._file.load()
        for d in builtin_dirs:
            self._load(_Repo(key=slugify(d.name), dir=d, kind="builtin"))
        for key, rec in self._data.repos.items():
            self._load(_Repo(key=key, dir=self._store_dir(key, rec.commit), kind="git"))
        for folder in self._data.dev_folders:
            path = Path(folder)
            self._load(_Repo(key=dev_key(path), dir=path, kind="dev"))

    # ---- read API used by the server -------------------------------------------------------

    def repo_dir(self, repo_key: str) -> Path | None:
        with self._lock:
            repo = self._repos.get(repo_key)
            return repo.dir if repo else None

    def entry(self, repo_key: str, viz_id: str) -> Mapping[str, Any] | None:
        with self._lock:
            repo = self._repos.get(repo_key)
            if repo is None or repo.manifest is None:
                return None
            return next((v for v in repo.manifest["visualizers"] if v["id"] == viz_id), None)

    def is_dev(self, repo_key: str) -> bool:
        with self._lock:
            repo = self._repos.get(repo_key)
            return repo is not None and repo.kind == "dev"

    def visualizers(self) -> list[dict[str, Any]]:
        """VizInfo minus the URL/values fields the server composes (it adds entryUrl etc.)."""
        with self._lock:
            out: list[dict[str, Any]] = []
            for repo in self._repos.values():
                if repo.manifest is None:
                    continue
                for v in repo.manifest["visualizers"]:
                    key = f"{repo.key}/{v['id']}"
                    out.append(
                        {
                            "key": key,
                            "repo": repo.key,
                            "id": v["id"],
                            "name": v["name"],
                            "description": v.get("description", ""),
                            "author": v.get("author", ""),
                            "renderer": v["renderer"],
                            "params": v.get("params", []),
                            "libs": v.get("libs", []),
                            "fallback": v.get("fallback"),
                            "entry": v["entry"],
                            "thumbnail": v.get("thumbnail"),
                            "disabled": key in self._data.disabled,
                            "dev": repo.kind == "dev",
                            "builtin": repo.kind == "builtin",
                        }
                    )
            return out

    def repos(self) -> list[dict[str, Any]]:
        """RepoInfo per protocols §4, plus `errors` (manifest problems, e.g. in a dev folder)."""
        with self._lock:
            out: list[dict[str, Any]] = []
            for repo in self._repos.values():
                rec = self._data.repos.get(repo.key) if repo.kind == "git" else None
                out.append(
                    {
                        "repo": repo.key,
                        "url": rec.url if rec else None,
                        "path": str(repo.dir) if repo.kind != "git" else None,
                        "commit": rec.commit if rec else None,
                        "previous": rec.previous if rec else None,
                        "dev": repo.kind == "dev",
                        "builtin": repo.kind == "builtin",
                        "errors": [{"path": e.path, "message": e.message} for e in repo.errors],
                    }
                )
            return out

    def dev_folders(self) -> dict[str, Path]:
        with self._lock:
            return {r.key: r.dir for r in self._repos.values() if r.kind == "dev"}

    def record(self, repo_key: str) -> RepoRecord | None:
        with self._lock:
            return self._data.repos.get(repo_key)

    # ---- install flow ---------------------------------------------------------------------

    def prepare_install(self, url_text: str) -> PendingInstall:
        """Fetch + limits + validation. Nothing is registered until `confirm_install`."""
        try:
            spec = parse_repo_url(url_text)
        except RepoUrlError as e:
            raise InstallError(str(e)) from e
        with self._lock:
            if spec.key in self._repos:
                raise InstallError(f"{spec.display} is already installed")
        return self._prepare(spec)

    def confirm_install(self, pending_id: str) -> RepoRecord:
        """Move the pending checkout into the store and register it (install or update)."""
        with self._lock:
            pending = self._pending.pop(pending_id, None)
            if pending is None:
                raise InstallError("that install is no longer pending")
            key = pending.spec.key
            try:
                dest = self._store_dir(key, pending.commit)
                old = self._data.repos.get(key)
                if dest.exists():
                    _rmtree_read_only(dest)
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(pending.temp_dir, dest)
                _make_read_only(dest)
            finally:
                if pending.fetch_result is not None:
                    pending.fetch_result.discard()
            previous = old.commit if old and old.commit != pending.commit else None
            if old and previous is None:
                previous = old.previous
            record = RepoRecord(
                key=key,
                url=pending.spec.url,
                ref=pending.spec.ref,
                commit=pending.commit,
                previous=previous,
                installed_at=self._clock(),
                checked_at=old.checked_at if old else None,
            )
            self._data.repos[key] = record
            self._prune(key)
            self._save()
            self._load(_Repo(key=key, dir=dest, kind="git"))
            return record

    def cancel_install(self, pending_id: str) -> None:
        with self._lock:
            pending = self._pending.pop(pending_id, None)
        if pending is not None and pending.fetch_result is not None:
            pending.fetch_result.discard()

    # ---- updates --------------------------------------------------------------------------

    def check_updates(self, now: float) -> list[dict[str, str]]:
        """Compare each git repo's ref with the remote, at most once per 24 h per repo.

        Never applies anything. Returns `[{repo, commit (short SHA), message}]` for every repo
        with a newer commit known, including ones found by an earlier check.
        """
        with self._lock:
            due = [
                (r.key, r.url, r.ref)
                for r in self._data.repos.values()
                if (r.checked_at is None or now - r.checked_at >= UPDATE_CHECK_INTERVAL_S)
                and not (r.ref and len(r.ref) == 40 and r.ref == r.commit)
            ]
        results: dict[str, tuple[str, str]] = {}
        for key, url, ref in due:
            try:
                results[key] = self._fetcher.remote_head(url, ref)
            except Exception as e:
                log.info("update check for %s failed: %s", key, e)
        with self._lock:
            for key, (sha, message) in results.items():
                rec = self._data.repos.get(key)
                if rec is None:
                    continue
                rec.checked_at = now
                rec.update = None if sha == rec.commit else {"commit": sha, "message": message}
            if results:
                self._save()
            return [
                {"repo": r.key, "commit": r.update["commit"][:7], "message": r.update["message"]}
                for r in self._data.repos.values()
                if r.update is not None
            ]

    def update(self, repo_key: str) -> PendingInstall:
        """Re-run the install flow (fetch, limits, validation) for the repo's ref."""
        with self._lock:
            rec = self._data.repos.get(repo_key)
            if rec is None:
                raise InstallError(f"{repo_key} isn't an installed git repo")
            spec = parse_repo_url(rec.url + (f"#{rec.ref}" if rec.ref else ""))
            current = rec.commit
        pending = self._prepare(spec)
        if pending.commit == current:
            self.cancel_install(pending.id)
            with self._lock:
                rec.update = None
                self._save()
            raise InstallError(f"{spec.display} is already up to date")
        return pending

    def rollback(self, repo_key: str) -> RepoRecord:
        """Swap to the previous commit (kept on disk; no network)."""
        with self._lock:
            rec = self._data.repos.get(repo_key)
            if rec is None:
                raise InstallError(f"{repo_key} isn't an installed git repo")
            if rec.previous is None or not self._store_dir(repo_key, rec.previous).is_dir():
                raise InstallError("there is no previous version to roll back to")
            rec.commit, rec.previous = rec.previous, rec.commit
            rec.update = None
            rec.checked_at = None
            self._save()
            self._load(_Repo(key=repo_key, dir=self._store_dir(repo_key, rec.commit), kind="git"))
            return rec

    def remove(self, repo_key: str) -> None:
        """Unregister a repo. Installed checkouts are deleted; dev folders are left untouched."""
        with self._lock:
            repo = self._repos.get(repo_key)
            if repo is None:
                raise InstallError(f"unknown repo {repo_key}")
            if repo.kind == "builtin":
                raise InstallError("built-in visualizers can't be removed")
            del self._repos[repo_key]
            if repo.kind == "git":
                self._data.repos.pop(repo_key, None)
                _rmtree_read_only(self.paths.plugins / repo_key)
            else:
                self._data.dev_folders = [
                    f for f in self._data.dev_folders if dev_key(Path(f)) != repo_key
                ]
            self._data.disabled = {
                k for k in self._data.disabled if not k.startswith(f"{repo_key}/")
            }
            self._save()

    # ---- dev folders ----------------------------------------------------------------------

    def add_dev_folder(self, path: Path) -> str:
        """Register a local folder in place (no copy) after validating it. Returns its key."""
        folder = path.resolve()
        result = load_manifest(folder)
        if result.errors or result.manifest is None:
            raise ManifestInvalid(result.errors)
        key = dev_key(folder)
        with self._lock:
            if key not in self._repos:
                self._data.dev_folders.append(str(folder))
                self._save()
            self._repos[key] = _Repo(key=key, dir=folder, kind="dev", manifest=result.manifest)
        return key

    def reload(self, repo_key: str) -> list[ManifestError]:
        """Re-validate a repo's manifest. On errors the last valid manifest stays registered."""
        with self._lock:
            repo = self._repos.get(repo_key)
            if repo is None:
                return [ManifestError("", f"unknown repo {repo_key}")]
        result = load_manifest(repo.dir)
        with self._lock:
            repo.errors = result.errors
            if not result.errors:
                repo.manifest = result.manifest
            return list(result.errors)

    # ---- disable --------------------------------------------------------------------------

    def disable(self, key: str) -> None:
        with self._lock:
            self._data.disabled.add(key)
            self._save()

    def enable(self, key: str) -> None:
        with self._lock:
            self._data.disabled.discard(key)
            self._save()

    # ---- internals ------------------------------------------------------------------------

    def _prepare(self, spec: RepoSpec) -> PendingInstall:
        result = self._fetcher.fetch(spec.url, spec.ref)
        loaded = load_manifest(result.checkout)
        if loaded.errors or loaded.manifest is None:
            result.discard()
            raise ManifestInvalid(loaded.errors)
        pending = PendingInstall(
            id=secrets.token_urlsafe(12),
            spec=spec,
            commit=result.commit,
            message=result.message,
            visualizers=[
                {"id": v["id"], "name": v["name"]} for v in loaded.manifest["visualizers"]
            ],
            temp_dir=result.checkout,
            warnings=list(result.warnings),
            fetch_result=result,
        )
        with self._lock:
            self._pending[pending.id] = pending
        return pending

    def _store_dir(self, key: str, commit: str) -> Path:
        return self.paths.plugins / key / commit

    def _prune(self, key: str) -> None:
        rec = self._data.repos[key]
        keep = {rec.commit, rec.previous}
        base = self.paths.plugins / key
        if not base.is_dir():
            return
        for child in base.iterdir():
            if child.name not in keep:
                _rmtree_read_only(child)

    def _load(self, repo: _Repo) -> None:
        result = load_manifest(repo.dir)
        if result.errors and not repo.dir.is_dir():
            result = type(result)(None, [ManifestError("", f"folder not found: {repo.dir}")])
        repo.manifest = None if result.errors else result.manifest
        repo.errors = result.errors
        self._repos[repo.key] = repo

    def _save(self) -> None:
        self._file.save(self._data)

    def _clean_cache(self) -> None:
        """Temp fetches never survive a restart (pending installs are in memory only)."""
        cache = self.paths.cache
        if not cache.is_dir():
            return
        for pattern in ("fetch-*", "check-*"):
            for child in cache.glob(pattern):
                shutil.rmtree(child, ignore_errors=True)
