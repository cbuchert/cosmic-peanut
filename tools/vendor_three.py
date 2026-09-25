"""Vendor the pinned three.js into web/vendor/three/ (served at /lib/three/ to plugins).

uv run python -m tools.vendor_three

Downloads the npm tarball with urllib (no Node needed), checks it against the registry's sha512
`dist.integrity`, and writes a trimmed tree matching the plugin import map (docs/protocols.md §3):

    three          -> /lib/three/three.module.js   (+ three.core.js, which it imports)
    three/addons/  -> /lib/three/addons/           (examples/jsm, minus what can't load or is heavy)

The import map maps only `three` and `three/addons/`, so addons that import `three/webgpu`,
`three/tsl` or a URL can't load in a plugin and are dropped, along with anything that imports a
dropped file. Heavy decoder blobs (Draco, Basis) and WebXR/physics/tooling dirs are excluded.
"""

import base64
import hashlib
import io
import json
import posixpath
import re
import shutil
import tarfile
import urllib.request
from pathlib import Path

PINNED_VERSION = "0.186.1"
SIZE_CAP = 8 * 1024 * 1024
DEST = Path(__file__).resolve().parent.parent / "web" / "vendor" / "three"
REGISTRY = "https://registry.npmjs.org/three/"

# examples/jsm subtrees that are heavy or can't work inside a sandboxed plugin iframe.
EXCLUDED_ADDON_DIRS = (
    "libs/basis/",  # Basis transcoder wasm
    "libs/draco/",  # Draco decoder wasm
    "offscreen/",  # worker demos
    "tsl/",  # WebGPU node library (needs three/tsl)
    "inspector/",  # WebGPU dev tooling
    "transpiler/",  # GLSL -> TSL tooling
    "webxr/",  # no XR in a plugin iframe
    "physics/",  # wrappers for external wasm engines
)

_COMMENT_BLOCK = re.compile(rb"/\*.*?\*/", re.S)
_COMMENT_LINE = re.compile(rb"^\s*//.*$", re.M)
_IMPORT = re.compile(
    rb"""(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\1""",
)


def verify_integrity(data: bytes, integrity: str) -> None:
    """Check `data` against an npm Subresource-Integrity string (`sha512-<base64>`)."""
    algo, _, expected = integrity.partition("-")
    if algo != "sha512":
        raise ValueError(f"expected a sha512 integrity string, got {algo!r}")
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != expected:
        raise ValueError("tarball integrity mismatch (sha512)")


def _imports(source: bytes) -> list[str]:
    code = _COMMENT_LINE.sub(b"", _COMMENT_BLOCK.sub(b"", source))
    return [m.group(2).decode() for m in _IMPORT.finditer(code)]


def _resolve(importer: str, spec: str) -> str | None:
    """Vendor-tree path a specifier resolves to, or None when the import map can't serve it."""
    if spec == "three":
        return "three.module.js"
    if spec.startswith("three/addons/"):
        return "addons/" + spec.removeprefix("three/addons/")
    if spec.startswith(("./", "../")):
        return posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))
    return None


def unresolved_imports(files: dict[str, bytes]) -> list[str]:
    """`"<file> -> <specifier>"` for every JS import in `files` that doesn't resolve within it."""
    missing = []
    for path, data in sorted(files.items()):
        if not path.endswith(".js"):
            continue
        for spec in _imports(data):
            target = _resolve(path, spec)
            if target is None or target not in files:
                missing.append(f"{path} -> {spec}")
    return missing


def select_files(package: dict[str, bytes]) -> dict[str, bytes]:
    """Map package-relative paths to the trimmed vendor tree (dest-relative paths)."""
    build = {p.removeprefix("build/"): d for p, d in package.items() if p.startswith("build/")}
    out: dict[str, bytes] = {"LICENSE": package["LICENSE"]}

    # three.module.js and whatever build files it (transitively) imports.
    todo = ["three.module.js"]
    while todo:
        name = todo.pop()
        if name in out:
            continue
        out[name] = build[name]
        todo += [t for s in _imports(build[name]) if (t := _resolve(name, s)) in build]

    for path, data in package.items():
        rel = path.removeprefix("examples/jsm/")
        if rel == path or not rel.endswith(".js") or rel.startswith(EXCLUDED_ADDON_DIRS):
            continue
        out["addons/" + rel] = data

    # Drop addons with unloadable imports until the tree is closed.
    while True:
        bad = {line.split(" -> ")[0] for line in unresolved_imports(out)}
        bad = {p for p in bad if p.startswith("addons/")}
        if not bad:
            return out
        for p in bad:
            del out[p]


def _read_tarball(tgz: bytes) -> dict[str, bytes]:
    files = {}
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            f = tar.extractfile(member)
            assert f is not None
            files[member.name.removeprefix("package/")] = f.read()
    return files


def vendor(
    tgz: bytes, integrity: str, dest: Path, *, version: str, size_cap: int = SIZE_CAP
) -> int:
    """Verify, trim and write the tree to `dest` (replacing it). Returns total bytes written."""
    verify_integrity(tgz, integrity)
    files = select_files(_read_tarball(tgz))
    files["VERSION"] = f"{version}\n".encode()
    total = sum(len(d) for d in files.values())
    if total > size_cap:
        raise ValueError(f"vendored three.js is {total} bytes, over the {size_cap} byte cap")
    if dest.exists():
        shutil.rmtree(dest)
    for rel, data in files.items():
        path = dest / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return total


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def main() -> None:
    meta = json.loads(_get(REGISTRY + PINNED_VERSION))
    tgz = _get(meta["dist"]["tarball"])
    total = vendor(tgz, meta["dist"]["integrity"], DEST, version=PINNED_VERSION)
    count = sum(1 for p in DEST.rglob("*") if p.is_file())
    print(f"three {PINNED_VERSION}: {count} files, {total / 1e6:.2f} MB -> {DEST}")


if __name__ == "__main__":
    main()
