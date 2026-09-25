"""Parse what a user pastes into "Add from git" into a fetchable HTTPS URL, ref and repo key."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_SHORTHAND = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_REF = re.compile(r"^[A-Za-z0-9._/+-]{1,200}$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_SLUG_MAX = 60


class RepoUrlError(ValueError):
    """The text isn't an accepted repo URL; str() is a user-facing reason."""


@dataclass(frozen=True, slots=True)
class RepoSpec:
    url: str  # normalized https URL, no `.git`, no trailing slash
    ref: str | None  # branch, tag or full commit SHA; None = remote default branch
    key: str  # ^[a-z0-9-]+$, stable per repo URL (ignores ref)
    display: str  # short human form, e.g. "owner/repo#v1"


def slugify(text: str, max_len: int = _SLUG_MAX) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_len].rstrip("-") or "repo"


def hash8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def _check_ref(ref: str) -> str:
    if (
        not _REF.match(ref)
        or ".." in ref
        or ref.startswith(("-", "/", "."))
        or ref.endswith(("/", ".", ".lock"))
        or "//" in ref
    ):
        raise RepoUrlError(f"invalid ref {ref!r}: use a branch, tag or full commit SHA")
    return ref


def parse_repo_url(text: str) -> RepoSpec:
    """Accept `https://host/owner/repo(.git)` or GitHub `owner/repo`, each with optional `#ref`."""
    text = text.strip()
    if not text:
        raise RepoUrlError("empty repo URL")
    if any(c.isspace() for c in text):
        raise RepoUrlError("repo URL must not contain whitespace")
    lower = text.lower()
    if lower.startswith(("git@", "ssh://", "git+ssh://")) or re.match(r"^[\w.-]+@[\w.-]+:", text):
        raise RepoUrlError("SSH URLs aren't supported; use the https:// URL")
    ref: str | None = None
    if "#" in text:
        text, ref = text.split("#", 1)
        if "#" in ref or not ref:
            raise RepoUrlError("invalid ref after '#'")
        ref = _check_ref(ref)

    if "://" not in text:
        if not _SHORTHAND.match(text):
            if "/" in text and "." in text.split("/", 1)[0]:
                raise RepoUrlError("add https:// in front of the URL")
            raise RepoUrlError("expected https://host/owner/repo or owner/repo")
        text = "https://github.com/" + text

    scheme = text.split("://", 1)[0].lower()
    if scheme != "https":
        raise RepoUrlError(f"only https:// URLs are supported, not {scheme}://")
    parts = urlsplit(text)
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise RepoUrlError("URLs with credentials aren't supported (public repos only)")
    if parts.query or "?" in text:
        raise RepoUrlError("URL must not have a query string")
    try:
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError as e:
        raise RepoUrlError(f"invalid host: {e}") from e
    if not host:
        raise RepoUrlError("URL is missing a host")
    netloc = f"{host}:{port}" if port else host

    path = parts.path.strip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    segments = path.split("/") if path else []
    if len(segments) < 2 or any(s in ("", ".", "..") for s in segments):
        raise RepoUrlError("expected a repo path like https://host/owner/repo")

    url = f"https://{netloc}/{'/'.join(segments)}"
    key = f"{slugify('-'.join([host, *segments]))}-{hash8(url.lower())}"
    shown = "/".join(segments) if host == "github.com" else f"{netloc}/{'/'.join(segments)}"
    if ref is not None:
        shown += "#" + (ref[:7] if _SHA.match(ref) else ref)
    return RepoSpec(url=url, ref=ref, key=key, display=shown)
