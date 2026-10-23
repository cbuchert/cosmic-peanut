"""The bestiary's tile tool (tools/tiles): broken tiles must fail with a clear message."""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tools.tiles import check, geometry
from tools.tiles.geometry import TYPES, Shape

REPO = Path(__file__).resolve().parents[1]


def spec(kind: str, **over) -> dict:
    """A small valid tile of a type: gentle bumps on its free edges, an eye inside."""
    edges = {}
    for i, e in enumerate(TYPES[kind].free):
        b = 0.08 if i % 2 == 0 else -0.06
        edges[f"e{e}"] = {"bezier": [[0.3, b], [0.7, -b]]}
    centre = {"TTTTTT": (0.5, 0.87), "TGTG": (0.5, 0.5), "C4": (0.5, 0.5), "C3": (0.5, 0.87)}
    x, y = centre[kind]
    d = {
        "format": 1,
        "name": f"Test {kind}",
        "group": "fish",
        "type": kind,
        "edges": edges,
        "art": [
            {"part": "eye", "circle": [x, y, 0.06]},
            {
                "part": "gill",
                "stroke": {"polyline": [[x - 0.2, y - 0.1], [x - 0.2, y + 0.1]]},
                "width": 0.02,
            },
        ],
        "colours": {"eye": "paper", "gill": "cut"},
    }
    d.update(over)
    return d


def write(root: Path, name: str, data: dict, group: str = "fish") -> Path:
    p = root / group / f"{name}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data))
    return p


def index(root: Path) -> None:
    for g in root.iterdir():
        names = sorted(p.stem for p in g.glob("*.json") if p.name != "index.json")
        (g / "index.json").write_text(json.dumps({"species": names}))


def errors(issues: list[check.Issue]) -> list[str]:
    return [i.msg for i in issues if i.level == "error"]


@pytest.mark.parametrize("kind", list(TYPES))
def test_a_valid_tile_of_each_type_passes(tmp_path: Path, kind: str):
    write(tmp_path, "ok", spec(kind))
    index(tmp_path)
    assert errors(check.check_all(tmp_path)) == []


def test_self_intersecting_edge_fails(tmp_path: Path):
    # A loop: the edge doubles back over itself.
    bad = spec(
        "C4",
        edges={"e0": {"polyline": [[0.6, 0.1], [0.3, 0.2], [0.4, -0.1]]}, "e1": {"polyline": []}},
    )
    write(tmp_path, "loop", bad)
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert any("crosses itself" in e and "fish/loop" in e for e in errs), errs


def test_free_edge_crossing_its_derived_partner_fails(tmp_path: Path):
    # C4: e0 swings back past V0, so it meets e3 (its own quarter turn) there.
    bad = spec("C4", edges={"e0": {"polyline": [[-0.2, 0.3]]}, "e1": {"polyline": []}})
    write(tmp_path, "swing", bad)
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert any("crosses itself" in e for e in errs), errs


def test_art_outside_the_outline_fails(tmp_path: Path):
    s = spec("TGTG")
    s["art"][0]["circle"] = [1.1, 0.5, 0.05]
    write(tmp_path, "eye-out", s)
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert any("art[0]" in e and "eye" in e and "outline" in e for e in errs), errs


def test_stroke_poking_through_the_outline_fails(tmp_path: Path):
    s = spec("C3")
    s["art"][1]["stroke"] = {"polyline": [[0.5, 0.87], [0.5, 0.02]]}
    s["art"][1]["width"] = 0.08
    write(tmp_path, "gill-out", s)
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert any("art[1]" in e and "outline" in e for e in errs), errs


@pytest.mark.parametrize(
    ("over", "needle"),
    [
        ({"type": "p6"}, "type"),
        ({"format": 2}, "format"),
        ({"group": "birds"}, "folder name"),
        ({"colours": {"eye": "paper", "gill": "glitter"}}, "colour role"),
        ({"colours": {"eye": "paper"}}, 'part "gill"'),
        ({"edges": {"e0": {"bezier": [[0.5, 0.1]]}, "e1": {"polyline": []}}}, "3n − 1"),
        ({"edges": {"e0": {"polyline": []}}}, "edges.e1"),
        (
            {"edges": {"e0": {"polyline": []}, "e1": {"polyline": []}, "e2": {"polyline": []}}},
            "derived",
        ),
        ({"corners": {"w": 1}}, "corners"),
    ],
)
def test_bad_fields_are_named(tmp_path: Path, over: dict, needle: str):
    write(tmp_path, "bad", spec("C4", **over))
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert len(errs) == 1 and needle in errs[0] and "fish/bad" in errs[0], errs


def test_invalid_json_is_reported(tmp_path: Path):
    p = tmp_path / "fish/broken.json"
    p.parent.mkdir(parents=True)
    p.write_text("{nope")
    index(tmp_path)
    errs = errors(check.check_all(tmp_path))
    assert any("not valid JSON" in e for e in errs), errs


def test_coverage_finds_gaps_and_overlaps():
    sp = geometry.parse_species(spec("C3"), Path("fish/t.json"))
    shape = geometry.shape_of(sp)
    assert check.check_coverage(shape, "fish/t") == []
    centre = shape.outline.mean(0)
    shrunk = Shape(shape.type, shape.frame, centre + (shape.outline - centre) * 0.97, shape.edge_n)
    assert any("gap" in i.msg for i in check.check_coverage(shrunk, "fish/t"))
    grown = Shape(shape.type, shape.frame, centre + (shape.outline - centre) * 1.03, shape.edge_n)
    assert any("overlap" in i.msg for i in check.check_coverage(grown, "fish/t"))


def test_relations_are_checked_numerically():
    sp = geometry.parse_species(spec("TTTTTT"), Path("fish/t.json"))
    shape = geometry.shape_of(sp)
    assert check.check_relations(shape, "fish/t") == []
    bent = shape.outline.copy()
    bent[2] += [0.0, 0.05]  # move one point of E0 without its partner on E3
    issues = check.check_relations(Shape(shape.type, shape.frame, bent, shape.edge_n), "fish/t")
    assert any("e3" in i.msg for i in issues), issues


def test_a_blend_that_self_intersects_fails(tmp_path: Path):
    # Two compatible TGTG tiles, each fine alone; halfway between them e1 doubles back on itself.
    a = spec(
        "TGTG",
        edges={"e0": {"polyline": [[0.5, 0.0]]}, "e1": {"polyline": [[0.3, 0.3], [0.4, -0.3]]}},
    )
    b = spec(
        "TGTG",
        edges={"e0": {"polyline": [[0.5, 0.0]]}, "e1": {"polyline": [[0.6, -0.3], [0.2, 0.3]]}},
    )
    a["art"] = b["art"] = [{"part": "eye", "circle": [0.4, 0.5, 0.05]}]
    a["colours"] = b["colours"] = {"eye": "ink"}
    write(tmp_path, "a", a)
    write(tmp_path, "b", b)
    index(tmp_path)
    issues = check.check_all(tmp_path)
    errs = errors(issues)
    assert any("blend" in e and "fish/a" in e and "fish/b" in e for e in errs), errs


def test_compatible_species_are_listed(tmp_path: Path):
    write(tmp_path, "a", spec("C4"))
    write(tmp_path, "b", spec("C4", name="Other"))
    write(tmp_path, "c", spec("C3"))
    index(tmp_path)
    groups = check.compatible(check.load_all(tmp_path)[0])
    assert sorted(sorted(g) for g in groups if len(g) > 1) == [["fish/a", "fish/b"]]


def test_stale_index_fails(tmp_path: Path):
    write(tmp_path, "a", spec("C4"))
    index(tmp_path)
    write(tmp_path, "b", spec("C4"))
    errs = errors(check.check_all(tmp_path))
    assert any("index.json" in e and "tools.tiles index" in e for e in errs), errs
    check.write_indexes(tmp_path)
    assert errors(check.check_all(tmp_path)) == []
    assert json.loads((tmp_path / "fish/index.json").read_text()) == {"species": ["a", "b"]}


def test_thin_neck_warns(tmp_path: Path):
    # e0 and e1 bulge in until their tips nearly meet: a lobe hangs off the body by a thread.
    s = spec("C4", edges={"e0": {"polyline": [[0.5, 0.48]]}, "e1": {"polyline": [[0.5, 0.47]]}})
    s["art"] = [{"part": "eye", "circle": [0.3, 0.7, 0.05]}]
    s["colours"] = {"eye": "ink"}
    write(tmp_path, "neck", s)
    index(tmp_path)
    issues = check.check_all(tmp_path)
    assert errors(issues) == []
    assert any(i.level == "warning" and "neck" in i.msg for i in issues), issues


def test_cli_check_and_preview(tmp_path: Path):
    write(tmp_path, "a", spec("C4"))
    write(tmp_path, "b", spec("C4", name="Other"))
    index(tmp_path)
    run = [sys.executable, "-m", "tools.tiles"]
    ok = subprocess.run(
        [*run, "check", "--root", str(tmp_path)], cwd=REPO, capture_output=True, text=True
    )
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "2 species" in ok.stdout
    out = tmp_path / "out"
    pv = subprocess.run(
        [*run, "preview", "--root", str(tmp_path), "--out", str(out), "--fast", "fish/a"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert pv.returncode == 0, pv.stdout + pv.stderr
    png = (out / "fish-a.png").read_bytes()
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    write(tmp_path, "c", spec("C4", type="p6"))
    index(tmp_path)
    bad = subprocess.run(
        [*run, "check", "--root", str(tmp_path)], cwd=REPO, capture_output=True, text=True
    )
    assert bad.returncode == 1
    assert "fish/c" in bad.stdout


def test_png_writer_round_trips_size(tmp_path: Path):
    from tools.tiles.raster import write_png

    img = np.zeros((3, 5, 3))
    write_png(tmp_path / "x.png", img)
    data = (tmp_path / "x.png").read_bytes()
    assert int.from_bytes(data[16:20], "big") == 5 and int.from_bytes(data[20:24], "big") == 3


def test_smooth_edges_and_paths_pass_through_their_points():
    s = spec("C4")
    s["edges"]["e0"] = {"smooth": [[0.25, 0.1], [0.5, -0.05], [0.75, 0.1]]}
    s["art"][1] = {
        "part": "gill",
        "fill": {"smooth": [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]},
    }
    sp = geometry.parse_species(s, Path("fish/s.json"))
    assert "e0=s3" in sp.sig
    e = sp.edges[0]
    assert len(e) == 4 * geometry.FLAT
    want = [[0.25, 0.1], [0.5, -0.05], [0.75, 0.1], [1, 0]]
    assert np.allclose(e[geometry.FLAT - 1 :: geometry.FLAT], want)
    fill = sp.prims[1].points
    assert len(fill) == 1 + 4 * geometry.FLAT and np.allclose(fill[-1], [0.4, 0.4])
