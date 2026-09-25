"""Safe resolution of URL paths to files under a base directory."""

from pathlib import Path
from urllib.parse import unquote

_FORBIDDEN_CHARS = ("/", "\\", "\x00")


def resolve_under(base: Path, raw: str) -> Path | None:
    """Resolve a still-percent-encoded URL tail to a regular file inside ``base``.

    Returns None (the caller answers 404) for anything that is not plainly a file under
    ``base``: empty, ``.``/``..`` or hidden segments, encoded or literal ``/``, ``\\`` or NUL
    inside a segment, absolute paths, directories, missing files, and symlinks that resolve
    outside ``base``.
    """
    if not raw or "\\" in raw:
        return None
    parts: list[str] = []
    for segment in raw.split("/"):
        try:
            name = unquote(segment, errors="strict")
        except UnicodeDecodeError:
            return None
        if not name or name.startswith(".") or any(c in name for c in _FORBIDDEN_CHARS):
            return None
        parts.append(name)
    try:
        root = base.resolve(strict=True)
        target = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not target.is_relative_to(root) or not target.is_file():
        return None
    return target
