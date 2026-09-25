"""Manifest (tidalviz.json) validation."""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

SCHEMA_PATH = Path(__file__).with_name("manifest.schema.json")

_PATTERN_TEXT = {
    "relPath": "must be a relative path inside the repo (no leading '/', no '..', no ':')",
    "vizId": "must be 1-40 characters of a-z0-9- (lowercase letters, digits, dashes)",
    "paramId": "must start with a letter, then up to 39 letters, digits, '_' or '-'",
}
_TYPE_TEXT = {
    "object": "an object",
    "array": "an array",
    "string": "a string",
    "number": "a number",
    "boolean": "a boolean",
    "integer": "an integer",
}


@dataclass(frozen=True, slots=True)
class ManifestError:
    """One validation problem: a field path like `visualizers[0].params[2].default` and a reason."""

    path: str
    message: str


@cache
def _schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return schema


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(_schema())


def _iter_errors(obj: Any) -> list[ValidationError]:
    validator: Any = _validator()  # jsonschema's stubs are partially unknown
    return list(validator.iter_errors(obj))


def format_path(parts: Iterable[str | int]) -> str:
    out = ""
    for p in parts:
        if isinstance(p, int):
            out += f"[{p}]"
        else:
            out += f".{p}" if out else p
    return out


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _schema_errors(e: ValidationError) -> Iterator[ManifestError]:
    parts: list[str | int] = list(e.absolute_path)
    v = e.validator
    arg: Any = e.validator_value
    inst: Any = e.instance
    if v == "required":
        missing = [k for k in arg if isinstance(inst, dict) and k not in inst]
        for k in missing:
            yield ManifestError(format_path([*parts, k]), "is required")
        return
    if v == "additionalProperties" and isinstance(inst, dict):
        allowed: dict[str, Any] = e.schema.get("properties", {})  # type: ignore[union-attr]
        keys: list[str] = list(inst)  # pyright: ignore[reportUnknownArgumentType]
        for k in keys:
            if k not in allowed:
                yield ManifestError(format_path([*parts, k]), "is not allowed here")
        return
    if v == "const":
        msg = f"must be {json.dumps(arg)}"
    elif v == "enum":
        msg = "must be one of: " + ", ".join(str(x) for x in arg)
    elif v == "type":
        msg = f"must be {_TYPE_TEXT.get(str(arg), str(arg))}"
    elif v == "pattern":
        if arg == "^#[0-9a-fA-F]{6}$":
            msg = "must be a color like #rrggbb"
        else:
            msg = _PATTERN_TEXT.get(_def_name(e), f"must match {arg}")
    elif v == "minItems":
        msg = f"must have at least {_plural(arg, 'item')}"
    elif v == "maxItems":
        msg = f"must have at most {_plural(arg, 'item')}"
    elif v == "minLength":
        msg = "must not be empty" if arg == 1 else f"must be at least {arg} characters"
    elif v == "maxLength":
        msg = f"must be at most {arg} characters"
    elif v == "uniqueItems":
        msg = "must not contain duplicates"
    elif v == "exclusiveMinimum":
        msg = f"must be greater than {arg}"
    else:
        msg = e.message
    yield ManifestError(format_path(parts), msg)


def _def_name(e: ValidationError) -> str:
    """Name of the `$defs` entry whose schema raised the error, or ''."""
    defs: dict[str, Any] = _schema()["$defs"]
    return next((name for name, schema in defs.items() if schema == e.schema), "")


def _num(x: object) -> float | None:
    return float(x) if isinstance(x, int | float) and not isinstance(x, bool) else None


def _dicts(x: object) -> list[tuple[int, dict[str, Any]]]:
    """(index, item) for the dict items of a list; anything else yields nothing."""
    if not isinstance(x, list):
        return []
    items: list[Any] = x  # pyright: ignore[reportUnknownVariableType]
    return [(i, item) for i, item in enumerate(items) if isinstance(item, dict)]


def _check_param(p: dict[str, Any], at: list[str | int]) -> Iterator[ManifestError]:
    if p.get("type") == "number":
        lo, hi, d = _num(p.get("min")), _num(p.get("max")), _num(p.get("default"))
        if lo is not None and hi is not None:
            if lo >= hi:
                yield ManifestError(
                    format_path([*at, "max"]), f"must be greater than min ({p['min']})"
                )
            elif d is not None and not lo <= d <= hi:
                yield ManifestError(
                    format_path([*at, "default"]),
                    f"must be between {p['min']} and {p['max']} (min and max)",
                )
    elif p.get("type") == "select":
        options, d = p.get("options"), p.get("default")
        if isinstance(options, list) and isinstance(d, str) and d not in options:
            yield ManifestError(format_path([*at, "default"]), "must be one of the options")


def _semantic_errors(obj: object) -> Iterator[ManifestError]:
    if not isinstance(obj, dict):
        return
    manifest: dict[str, Any] = obj  # pyright: ignore[reportUnknownVariableType]
    vizs = _dicts(manifest.get("visualizers"))
    renderers: dict[object, object] = {}
    for _, v in vizs:
        renderers.setdefault(v.get("id"), v.get("renderer"))
    seen: set[object] = set()
    for i, v in vizs:
        at: list[str | int] = ["visualizers", i]
        vid = v.get("id")
        if isinstance(vid, str):
            if vid in seen:
                yield ManifestError(format_path([*at, "id"]), f"duplicate visualizer id {vid!r}")
            seen.add(vid)
        fallback = v.get("fallback")
        if isinstance(fallback, str):
            if v.get("renderer") != "webgpu":
                yield ManifestError(
                    format_path([*at, "fallback"]), "is only allowed on webgpu visualizers"
                )
            elif fallback not in renderers:
                yield ManifestError(
                    format_path([*at, "fallback"]), f"no visualizer with id {fallback!r} here"
                )
            elif renderers[fallback] == "webgpu":
                yield ManifestError(
                    format_path([*at, "fallback"]), "must name a visualizer that isn't webgpu"
                )
        libs = v.get("libs", [])
        if v.get("renderer") == "three" and isinstance(libs, list) and "three" not in libs:
            yield ManifestError(
                format_path([*at, "libs"]), 'must include "three" for renderer three'
            )
        param_ids: set[object] = set()
        for j, p in _dicts(v.get("params")):
            pat: list[str | int] = [*at, "params", j]
            pid = p.get("id")
            if isinstance(pid, str):
                if pid in param_ids:
                    yield ManifestError(format_path([*pat, "id"]), f"duplicate param id {pid!r}")
                param_ids.add(pid)
            yield from _check_param(p, pat)


def validate_manifest(obj: Any) -> list[ManifestError]:
    """Validate a parsed manifest. Returns an empty list when it is valid."""
    errors: list[ManifestError] = []
    for e in sorted(_iter_errors(obj), key=lambda e: list(map(str, e.absolute_path))):
        errors.extend(_schema_errors(e))
    for err in _semantic_errors(obj):
        if err not in errors:
            errors.append(err)
    return errors


MANIFEST_NAME = "tidalviz.json"
MAX_MANIFEST_BYTES = 256 * 1024


@dataclass(frozen=True, slots=True)
class ManifestResult:
    """A loaded manifest (None if it couldn't be parsed) and every problem found."""

    manifest: dict[str, Any] | None
    errors: list[ManifestError]


def resolve_inside(root: Path, rel: str) -> Path | None:
    """Resolve `rel` under `root`, following symlinks; None if the result escapes `root`."""
    base = root.resolve()
    target = (base / rel).resolve()
    return target if target.is_relative_to(base) else None


def _file_errors(repo_dir: Path, manifest: dict[str, Any]) -> Iterator[ManifestError]:
    for i, v in enumerate(manifest["visualizers"]):
        for field in ("entry", "thumbnail"):
            rel = v.get(field)
            if rel is None:
                continue
            path = format_path(["visualizers", i, field])
            target = resolve_inside(repo_dir, rel)
            if target is None:
                yield ManifestError(path, f"points outside the repo: {rel}")
            elif not target.is_file():
                yield ManifestError(path, f"file not found: {rel}")


def load_manifest(repo_dir: Path) -> ManifestResult:
    """Read and validate `<repo_dir>/tidalviz.json`, including the files it references."""
    path = repo_dir / MANIFEST_NAME
    try:
        if resolve_inside(repo_dir, MANIFEST_NAME) is None:
            raise FileNotFoundError
        if path.stat().st_size > MAX_MANIFEST_BYTES:
            return ManifestResult(None, [ManifestError(MANIFEST_NAME, "is larger than 256 KB")])
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ManifestResult(None, [ManifestError(MANIFEST_NAME, "not found at the repo root")])
    except (OSError, UnicodeDecodeError) as e:
        return ManifestResult(None, [ManifestError(MANIFEST_NAME, f"can't be read: {e}")])
    try:
        data: Any = json.loads(text)
    except json.JSONDecodeError as e:
        msg = f"invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}"
        return ManifestResult(None, [ManifestError(MANIFEST_NAME, msg)])
    errors = validate_manifest(data)
    if errors:
        return ManifestResult(None, errors)
    return ManifestResult(data, list(_file_errors(repo_dir, data)))
