"""The bestiary's tile tool.

uv run python -m tools.tiles check [ID ...]      validate species (all by default); exit 1 on errors
uv run python -m tools.tiles preview [ID ...]    PNG sheets into --out (default /tmp/tiles-preview)
uv run python -m tools.tiles index               rewrite each group's index.json from its folder
uv run python -m tools.tiles fmt [ID ...]        rewrite species files in the house style
uv run python -m tools.tiles golden              rewrite tests/fixtures/tiles_golden.json

IDs are <group>/<name> (e.g. fish/koi), the file plugins/builtin/tiles/<group>/<name>.json.
"""

import argparse
import json
import sys
from pathlib import Path

from . import check, fmt, geometry, golden, preview


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m tools.tiles", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "preview", "index", "golden", "fmt"):
        p = sub.add_parser(name)
        p.add_argument("--root", type=Path, default=geometry.TILES, help="tiles folder")
        if name in ("check", "preview", "fmt"):
            p.add_argument("ids", nargs="*", help="species ids (<group>/<name>); default all")
        if name == "preview":
            p.add_argument("--out", type=Path, default=Path("/tmp/tiles-preview"))
            p.add_argument("--fast", action="store_true", help="smaller, quicker sheets")
    a = ap.parse_args()

    if a.cmd == "index":
        for f in check.write_indexes(a.root):
            print("wrote", f)
        return 0
    if a.cmd == "fmt":
        for p in geometry.species_files(a.root):
            if a.ids and f"{p.parent.name}/{p.stem}" not in a.ids:
                continue
            text = fmt.dumps(json.loads(p.read_text()))
            if p.read_text() != text:
                p.write_text(text)
                print("formatted", p)
        return 0
    if a.cmd == "golden":
        print("wrote", golden.write(a.root))
        return 0
    if a.cmd == "preview":
        species, issues = check.load_all(a.root)
        for i in issues:
            print(i)
        todo = [s for s in species if not a.ids or s.id in a.ids]
        for sp in todo:
            print("wrote", preview.sheet(sp, species, a.out, fast=a.fast), flush=True)
        return 1 if issues and any(i.where in (a.ids or [i.where]) for i in issues) else 0

    issues = check.check_all(a.root, a.ids or None)
    species, _ = check.load_all(a.root)
    shown = [s for s in species if not a.ids or s.id in a.ids]
    for sp in shown:
        mine = [i for i in issues if i.where == sp.id]
        status = "ok" if not any(i.level == "error" for i in mine) else "FAILED"
        print(f"{sp.id:28} {sp.type:7} {status}")
        for i in mine:
            print("   ", i)
    for i in issues:
        if not any(i.where == sp.id for sp in shown):
            print(i)
    groups = [grp for grp in check.compatible(species) if len(grp) > 1]
    if groups:
        print("morph-compatible:", "; ".join(", ".join(grp) for grp in groups))
    n_err = sum(i.level == "error" for i in issues)
    n_warn = sum(i.level == "warning" for i in issues)
    print(f"{len(shown)} species, {n_err} errors, {n_warn} warnings")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
