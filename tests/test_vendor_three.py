import base64
import hashlib
import io
import re
import tarfile
from pathlib import Path

import pytest

from tools import vendor_three as vt

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "web" / "vendor" / "three"


def _integrity(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def _tarball(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


PACKAGE = {
    "LICENSE": "MIT",
    "package.json": "{}",
    "build/three.module.js": "import { A } from './three.core.js';\nexport { A };\n",
    "build/three.core.js": "export const A = 1;\n",
    "build/three.webgpu.js": "export const W = 1;\n",
    "src/Three.js": "export {};\n",
    "examples/jsm/postprocessing/EffectComposer.js": (
        "import { A } from 'three';\nimport { CopyShader } from '../shaders/CopyShader.js';\n"
    ),
    "examples/jsm/shaders/CopyShader.js": "export const CopyShader = {};\n",
    "examples/jsm/libs/draco/draco_decoder.js": "x",
    "examples/jsm/tsl/display/BloomNode.js": "import { x } from 'three/tsl';\n",
    "examples/jsm/objects/SkyMesh.js": "import { M } from 'three/webgpu';\n",
    "examples/jsm/objects/Uses.js": "import { SkyMesh } from './SkyMesh.js';\n",
    "examples/jsm/objects/Sky.js": "import { A } from 'three';\n",
}


def test_verify_integrity_accepts_matching_sha512():
    vt.verify_integrity(b"abc", _integrity(b"abc"))


def test_verify_integrity_rejects_mismatch():
    with pytest.raises(ValueError, match="integrity"):
        vt.verify_integrity(b"abc", _integrity(b"abd"))


def test_verify_integrity_rejects_non_sha512():
    with pytest.raises(ValueError, match="sha512"):
        vt.verify_integrity(b"abc", "sha1-AAAA")


def test_select_keeps_module_and_its_imports_flattened():
    out = vt.select_files({k: v.encode() for k, v in PACKAGE.items()})
    assert "three.module.js" in out
    assert "three.core.js" in out
    assert "three.webgpu.js" not in out
    assert "LICENSE" in out
    assert not any(k.startswith(("src/", "build/")) for k in out)


def test_select_keeps_addons_under_addons_dir():
    out = vt.select_files({k: v.encode() for k, v in PACKAGE.items()})
    assert "addons/postprocessing/EffectComposer.js" in out
    assert "addons/shaders/CopyShader.js" in out
    assert "addons/objects/Sky.js" in out


def test_select_drops_heavy_dirs_and_unmapped_bare_imports_transitively():
    out = vt.select_files({k: v.encode() for k, v in PACKAGE.items()})
    assert "addons/libs/draco/draco_decoder.js" not in out
    assert "addons/tsl/display/BloomNode.js" not in out
    assert "addons/objects/SkyMesh.js" not in out  # imports three/webgpu (not in the import map)
    assert "addons/objects/Uses.js" not in out  # imports a dropped file


def test_vendor_writes_files_version_and_clears_stale(tmp_path: Path):
    tgz = _tarball(PACKAGE)
    (tmp_path / "stale.js").write_text("old")
    total = vt.vendor(tgz, _integrity(tgz), tmp_path, version="9.9.9")
    assert (tmp_path / "VERSION").read_text().strip() == "9.9.9"
    assert (tmp_path / "LICENSE").read_text() == "MIT"
    assert (tmp_path / "addons/postprocessing/EffectComposer.js").is_file()
    assert not (tmp_path / "stale.js").exists()
    assert total > 0


def test_vendor_refuses_over_size_cap(tmp_path: Path):
    tgz = _tarball(PACKAGE)
    with pytest.raises(ValueError, match="cap"):
        vt.vendor(tgz, _integrity(tgz), tmp_path, version="9.9.9", size_cap=10)


def test_vendor_refuses_bad_integrity_before_writing(tmp_path: Path):
    tgz = _tarball(PACKAGE)
    with pytest.raises(ValueError):
        vt.vendor(tgz, _integrity(b"other"), tmp_path / "out", version="9.9.9")
    assert not (tmp_path / "out").exists()


# --- The committed vendor tree -------------------------------------------------------------


def test_committed_version_matches_pin():
    assert (VENDOR / "VERSION").read_text().strip() == vt.PINNED_VERSION


def test_committed_tree_is_under_cap_and_licensed():
    total = sum(p.stat().st_size for p in VENDOR.rglob("*") if p.is_file())
    assert total <= vt.SIZE_CAP
    assert "MIT" in (VENDOR / "LICENSE").read_text()


def test_orbit_imports_resolve_in_vendor_tree():
    src = (ROOT / "plugins" / "builtin" / "src" / "orbit.js").read_text()
    specs = re.findall(r"""from\s+["'](three(?:/addons/[^"']+)?)["']""", src)
    assert "three/addons/postprocessing/UnrealBloomPass.js" in specs
    for spec in specs:
        rel = "three.module.js" if spec == "three" else spec.removeprefix("three/")
        assert (VENDOR / rel).is_file(), spec


def test_every_committed_relative_import_resolves():
    assert (VENDOR / "three.module.js").is_file()
    missing = vt.unresolved_imports(
        {str(p.relative_to(VENDOR)): p.read_bytes() for p in VENDOR.rglob("*.js")}
    )
    assert missing == []
