"""The shared outline fixture: tests/fixtures/tiles_golden.json pins tools/tiles/geometry.py and
plugins/builtin/src/lib/bestiary.js to the same derived outlines (pytest checks it is current,
vitest that the JS derives the same points)."""

from __future__ import annotations

import json
from pathlib import Path

from . import geometry as g

FIXTURE = g.REPO / "tests/fixtures/tiles_golden.json"
# The seeds only: the fixture tests the code (one per type, plus a morph pair), so designers adding
# species never touch it.
SEEDS = ("birds/tern", "fish/halibut", "fish/koi", "mammals/bat", "reptiles/turtle")


def build(root: Path = g.TILES) -> dict:
    species = [g.load(root / f"{sid}.json") for sid in SEEDS]

    def entry(shape: g.Shape) -> dict:
        return {
            "V": [round(float(v), 9) for v in shape.frame.V.ravel()],
            "L": [round(float(v), 9) for v in shape.frame.L.T.ravel()],  # a.x, a.y, b.x, b.y
            "outline": [round(float(v), 9) for v in shape.outline.ravel()],
        }

    out: dict = {"species": {}, "blends": []}
    for sp in species:
        out["species"][sp.id] = {"sig": sp.sig, **entry(g.shape_of(sp))}
    for i, a in enumerate(species):
        for b in species[i + 1 :]:
            if a.sig == b.sig:
                out["blends"].append({"a": a.id, "b": b.id, "w": 0.5, **entry(g.blend(a, b, 0.5))})
    return out


def write(root: Path = g.TILES) -> Path:
    FIXTURE.write_text(json.dumps(build(root), indent=1) + "\n")
    return FIXTURE
