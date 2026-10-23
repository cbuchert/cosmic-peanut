"""Tile geometry for the bestiary: the Python mirror of plugins/builtin/src/lib/bestiary.js.

Four isohedral (Heesch) types. The free edges are data; the others are derived by the type's
isometries, so the edge relations hold by construction. A free edge's points are in its chord
frame (u along the edge from its start vertex to its end vertex, v to the left, in chord
lengths); corners and chord-frame points blend linearly. tests/fixtures/tiles_golden.json pins
this module and the JS one to the same outlines.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

F64 = NDArray[np.float64]

S3 = math.sqrt(3)
THIRD = 2 * math.pi / 3
FLAT = 8  # samples per cubic Bézier segment (edges and art)
MAX_OUTLINE = 512
FORMAT = 1
GROUPS = ("fish", "birds", "reptiles", "mammals")
ROLES = ("fill", "ink", "paper", "cut", "accent", "shade", "light")
REPO = Path(__file__).resolve().parents[2]
TILES = REPO / "plugins/builtin/tiles"


@dataclass(frozen=True)
class TypeInfo:
    edges: int
    free: tuple[int, ...]
    copies: int
    classes: int
    scale: float  # plane units per tile-frame unit
    corners: tuple[str, ...]


TYPES: dict[str, TypeInfo] = {
    "TTTTTT": TypeInfo(6, (0, 1, 2), 1, 3, 1 / 3, ("v1", "v2", "v3")),
    "TGTG": TypeInfo(4, (0, 1), 2, 2, 1 / 2, ("w", "h", "s")),
    "C4": TypeInfo(4, (0, 1), 4, 2, 1 / 2, ()),
    "C3": TypeInfo(6, (0, 2, 4), 3, 3, 1 / 3, ("v1",)),
}


class SpeciesError(ValueError):
    """A species file that can't be read as a tile (message names the file and the field)."""


def default_corners(kind: str) -> F64:
    c = np.zeros(6)
    if kind == "TTTTTT":
        c[:] = [1, 0, 1.5, S3 / 2, 1, S3]
    elif kind == "TGTG":
        c[:3] = [1, 1, 0]
    elif kind == "C3":
        c[:2] = [1, 0]
    return c


def rot(x: float, y: float, cx: float, cy: float, a: float) -> tuple[float, float]:
    c, s = math.cos(a), math.sin(a)
    return cx + c * (x - cx) - s * (y - cy), cy + s * (x - cx) + c * (y - cy)


@dataclass
class Frame:
    """Vertices, period lattice (columns a, b), copies (2×3 affine base → copy) and colouring."""

    V: F64  # (n, 2)
    L: F64  # (2, 2): columns a, b
    copies: F64  # (k, 2, 3)
    copy_cls: list[int]
    ca: int
    cb: int
    nc: int


def frame_of(kind: str, cn: F64) -> Frame:
    def rotation(a: float) -> list[list[float]]:
        c, s = round(math.cos(a), 15), round(math.sin(a), 15)
        return [[c, -s, 0.0], [s, c, 0.0]]

    if kind == "TTTTTT":
        v1, v2, v3 = cn[0:2], cn[2:4], cn[4:6]
        v4, v5 = v3 - v1, v3 - v2
        V = np.array([[0, 0], v1, v2, v3, v4, v5], float)
        L = np.column_stack([v3 - v1, v4 - v2])
        return Frame(V, L, np.array([rotation(0)]), [0], 1, 2, 3)
    if kind == "TGTG":
        w, h, s = cn[0], cn[1], cn[2]
        V = np.array([[0, 0], [w, 0], [w + s, h], [s, h]], float)
        L = np.array([[w, 0], [0, 2 * h]], float)
        glide = [[-1.0, 0.0, w + s], [0.0, 1.0, h]]
        return Frame(V, L, np.array([rotation(0), glide]), [0, 1], 1, 0, 2)
    if kind == "C4":
        V = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
        L = np.array([[2, 0], [0, 2]], float)
        copies = np.array([rotation(k * math.pi / 2) for k in range(4)]).round(12)
        return Frame(V, L, copies, [0, 1, 0, 1], 0, 0, 2)
    v1 = (cn[0], cn[1])
    v5 = rot(*v1, 0, 0, THIRD)
    v3 = rot(*v5, 0, S3, THIRD)
    V = np.array([[0, 0], v1, [1.5, S3 / 2], v3, [0, S3], v5], float)
    L = np.array([[3, 1.5], [0, 3 * S3 / 2]], float)
    return Frame(V, L, np.array([rotation(k * THIRD) for k in range(3)]), [0, 1, 2], 0, 0, 3)


def flatten_bezier(ctrl: list[list[float]]) -> list[list[float]]:
    """Cubic chain a0 c c a1 … → the points after a0, FLAT per cubic, ending at the last anchor."""
    out: list[list[float]] = []
    for s in range(0, len(ctrl) - 3, 3):
        p0, p1, p2, p3 = ctrl[s : s + 4]
        for i in range(1, FLAT + 1):
            t = i / FLAT
            m = 1 - t
            a, b, d, e = m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t
            out.append(
                [
                    a * p0[0] + b * p1[0] + d * p2[0] + e * p3[0],
                    a * p0[1] + b * p1[1] + d * p2[1] + e * p3[1],
                ]
            )
    return out


def smooth_to_bezier(p: list[list[float]], closed: bool) -> list[list[float]]:
    """Uniform Catmull–Rom through the points as a cubic chain (mirrors bestiary.js)."""
    n = len(p)

    def at(i: int) -> list[float]:
        return p[i % n] if closed else p[max(0, min(n - 1, i))]

    out = [p[0]]
    for i in range(n if closed else n - 1):
        a, b, c, d = at(i - 1), at(i), at(i + 1), at(i + 2)
        out += [
            [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6],
            [c[0] - (d[0] - b[0]) / 6, c[1] - (d[1] - b[1]) / 6],
            c,
        ]
    return out


@dataclass
class Prim:
    kind: int  # 0 fill, 1 stroke, 2 circle
    role: int
    part: str
    index: int  # position in the file's "art" list
    points: F64  # (n, 2) tile frame; a circle: [[cx, cy]]
    w0: float = 0.0
    w1: float = 0.0
    r: float = 0.0
    height: float = 0.0


@dataclass
class Species:
    id: str
    path: Path
    name: str
    group: str
    type: str
    sig: str
    corners: F64
    edges: dict[int, F64]  # free edge → (n, 2) chord-frame points after the start, ending (1, 0)
    controls: dict[int, tuple[str, F64]]  # free edge → ("bezier" | "polyline", interior points)
    prims: list[Prim] = field(default_factory=list)
    dome: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict)


def _point(p: Any, where: str) -> list[float]:
    ok = isinstance(p, list) and len(p) == 2
    if not ok or not all(isinstance(v, int | float) and math.isfinite(v) for v in p):
        raise SpeciesError(f"{where}: points are [x, y] number pairs (got {json.dumps(p)})")
    return [float(p[0]), float(p[1])]


def _edge(e: Any, where: str) -> tuple[str, int, F64, F64]:
    if not isinstance(e, dict):
        raise SpeciesError(f'{where}: missing (needs "bezier", "smooth" or "polyline")')
    if isinstance(e.get("polyline"), list):
        pts = [_point(p, where) for p in e["polyline"]]
        flat = np.array([*pts, [1.0, 0.0]], float)
        return "polyline", len(pts), flat, np.array(pts, float).reshape(-1, 2)
    if isinstance(e.get("bezier"), list):
        m = len(e["bezier"])
        if m < 2 or (m + 1) % 3:
            raise SpeciesError(f"{where}: a bezier edge has 3n − 1 interior points (got {m})")
        pts = [_point(p, where) for p in e["bezier"]]
        flat = np.array(flatten_bezier([[0.0, 0.0], *pts, [1.0, 0.0]]), float)
        return "bezier", m, flat, np.array(pts, float)
    if isinstance(e.get("smooth"), list):
        pts = [_point(p, where) for p in e["smooth"]]
        chain = smooth_to_bezier([[0.0, 0.0], *pts, [1.0, 0.0]], False)
        return (
            "smooth",
            len(pts),
            np.array(flatten_bezier(chain), float),
            np.array(pts, float).reshape(-1, 2),
        )
    raise SpeciesError(f'{where}: needs "bezier", "smooth" or "polyline"')


def _path(p: Any, where: str, closed: bool) -> F64:
    if isinstance(p, dict) and isinstance(p.get("polyline"), list):
        if len(p["polyline"]) < 2:
            raise SpeciesError(f"{where}: a polyline needs at least 2 points")
        return np.array([_point(q, where) for q in p["polyline"]], float)
    if isinstance(p, dict) and isinstance(p.get("bezier"), list):
        m = len(p["bezier"])
        if m < 4 or (m - 1) % 3:
            raise SpeciesError(f"{where}: a bezier path has 3n + 1 points (got {m})")
        c = [_point(q, where) for q in p["bezier"]]
        return np.array([c[0], *flatten_bezier(c)], float)
    if isinstance(p, dict) and isinstance(p.get("smooth"), list):
        if len(p["smooth"]) < (3 if closed else 2):
            raise SpeciesError(f"{where}: a smooth path needs at least {3 if closed else 2} points")
        c = smooth_to_bezier([_point(q, where) for q in p["smooth"]], closed)
        return np.array([c[0], *flatten_bezier(c)], float)
    raise SpeciesError(f'{where}: needs "bezier", "smooth" or "polyline"')


NAME = re.compile(r"^[a-z0-9-]+$")


def parse_species(raw: Any, path: Path) -> Species:
    """Read a species file's JSON (mirrors bestiary.js parseSpecies, same messages)."""
    group, stem = path.parent.name, path.stem
    if not NAME.match(group) or not NAME.match(stem):
        raise SpeciesError(
            f"{path}: species files are tiles/<group>/<name>.json (lowercase, digits, -)"
        )
    sid = f"{group}/{stem}"

    def err(msg: str) -> SpeciesError:
        return SpeciesError(f"{sid}: {msg}")

    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise err(f"format must be {FORMAT}")
    if not isinstance(raw.get("name"), str) or not raw["name"]:
        raise err("name (the common name) is required")
    if raw.get("group") != group:
        raise err(f'group "{raw.get("group")}" must be the folder name "{group}"')
    kind = raw.get("type")
    if kind not in TYPES:
        raise err(f'type "{kind}" must be one of {", ".join(TYPES)}')
    info = TYPES[kind]

    corners = default_corners(kind)
    cj = raw.get("corners") or {}
    for k in cj:
        if k not in info.corners:
            raise err(f"corners.{k}: {kind} corners are {', '.join(info.corners) or 'fixed'}")
    for i, k in enumerate(info.corners):
        if k not in cj:
            continue
        if kind == "TGTG":
            if not isinstance(cj[k], int | float) or not math.isfinite(cj[k]):
                raise err(f"corners.{k} must be a number")
            corners[i] = float(cj[k])
        else:
            corners[i * 2 : i * 2 + 2] = _point(cj[k], f"{sid}: corners.{k}")

    edges: dict[int, F64] = {}
    controls: dict[int, tuple[str, F64]] = {}
    sig = [kind]
    ej = raw.get("edges") or {}
    for e in info.free:
        name, n, flat, ctrl = _edge(ej.get(f"e{e}"), f"{sid}: edges.e{e}")
        edges[e] = flat
        controls[e] = (name, ctrl)
        sig.append(f"e{e}={name[0]}{n}")
    for k in ej:
        if not re.match(r"^e\d$", k) or int(k[1:]) not in info.free:
            free = ", ".join(f"e{e}" for e in info.free)
            raise err(f"edges.{k}: {kind}'s free edges are {free} (the others are derived)")

    colours = raw.get("colours") or {}
    parts = (raw.get("height") or {}).get("parts") or {}
    prims: list[Prim] = []
    for i, a in enumerate(raw.get("art") or []):
        where = f"{sid}: art[{i}]"
        if not isinstance(a, dict) or not isinstance(a.get("part"), str) or not a["part"]:
            raise SpeciesError(f'{where}: needs a "part" name')
        part = a["part"]
        if part not in colours:
            raise SpeciesError(f'{where}: part "{part}" has no entry in "colours"')
        if colours[part] not in ROLES:
            raise SpeciesError(
                f'{where}: colour role "{colours[part]}" must be one of {", ".join(ROLES)}'
            )
        role = ROLES.index(colours[part])
        h = float(parts.get(part, 0)) if isinstance(parts.get(part, 0), int | float) else 0.0
        if isinstance(a.get("circle"), list):
            c = a["circle"]
            if len(c) != 3 or not all(isinstance(v, int | float) for v in c) or not c[2] > 0:
                raise SpeciesError(f"{where}: circle is [x, y, r > 0]")
            prims.append(Prim(2, role, part, i, np.array([c[:2]], float), r=float(c[2]), height=h))
            continue
        if a.get("fill"):
            prims.append(Prim(0, role, part, i, _path(a["fill"], where, True), height=h))
            continue
        if not a.get("stroke"):
            raise SpeciesError(f'{where}: needs "circle", "fill" or "stroke"')
        wd = a.get("width")
        wd = wd if isinstance(wd, list) else [wd, wd]
        if len(wd) != 2 or not all(isinstance(v, int | float) and v > 0 for v in wd):
            raise SpeciesError(f'{where}: a stroke needs "width" > 0 (or [start, end])')
        pts = _path(a["stroke"], where, False)
        prims.append(Prim(1, role, part, i, pts, w0=float(wd[0]), w1=float(wd[1]), height=h))
    for part in colours:
        if not any(p.part == part for p in prims):
            raise err(f"colours.{part}: no art uses this part")
    dome = (raw.get("height") or {}).get("dome", 0)
    return Species(
        sid,
        path,
        raw["name"],
        group,
        kind,
        " ".join(sig),
        corners,
        edges,
        controls,
        prims,
        float(dome) if isinstance(dome, int | float) else 0.0,
        raw,
    )


def load(path: Path) -> Species:
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise SpeciesError(f"{path}: not valid JSON ({e})") from e
    return parse_species(raw, path)


def plain_of(sp: Species) -> Species:
    """Default corners, straight edges, no art: every species blends with its plain tile."""
    edges = {}
    for e, pts in sp.edges.items():
        n = len(pts)
        edges[e] = np.column_stack([np.arange(1, n + 1) / n, np.zeros(n)])
    return Species(
        sp.id + "~plain",
        sp.path,
        sp.name,
        sp.group,
        sp.type,
        sp.sig,
        default_corners(sp.type),
        edges,
        sp.controls,
    )


@dataclass
class Shape:
    """A tile outline in the tile frame: closed CCW polygon starting after V0."""

    type: str
    frame: Frame
    outline: F64  # (n, 2)
    edge_n: list[int]

    def edge(self, e: int) -> F64:
        """Edge e's points, its start vertex first."""
        k = sum(self.edge_n[:e])
        return np.vstack([self.frame.V[e], self.outline[k : k + self.edge_n[e]]])


def _rot_pts(p: F64, c: F64, a: float) -> F64:
    m = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    return c + (p - c) @ m.T


def blend(a: Species, b: Species, w: float) -> Shape:
    """Outline of the blend (w = 0: a, 1: b); edges derived by the type's isometries."""
    if a.sig != b.sig:
        raise SpeciesError(f"{a.id} and {b.id} are not blend-compatible ({a.sig} ≠ {b.sig})")
    kind = a.type
    info = TYPES[kind]
    corners = a.corners + (b.corners - a.corners) * w
    f = frame_of(kind, corners)
    V = f.V
    ne = info.edges
    full: dict[int, F64] = {}  # edge → points start vertex first
    for e in info.free:
        uv = a.edges[e] + (b.edges[e] - a.edges[e]) * w
        A, B = V[e], V[(e + 1) % ne]
        d = B - A
        perp = np.array([-d[1], d[0]])
        full[e] = np.vstack([A, A + uv[:, :1] * d + uv[:, 1:] * perp])

    def rev(p: F64) -> F64:
        return p[::-1]

    if kind == "TTTTTT":
        full[3] = rev(full[0]) + (V[3] - V[1])
        full[4] = rev(full[1]) + (V[4] - V[2])
        full[5] = rev(full[2]) + (V[5] - V[3])
    elif kind == "TGTG":
        g = full[0].copy()
        g[:, 0] = V[2, 0] - g[:, 0]  # x ↦ (w + s) − x
        g[:, 1] += V[2, 1]  # y ↦ y + h
        full[2] = g
        full[3] = rev(full[1]) - np.array([V[1, 0], 0.0])
    elif kind == "C4":
        full[2] = rev(_rot_pts(full[1], V[2], -math.pi / 2))
        full[3] = rev(_rot_pts(full[0], V[0], math.pi / 2))
    else:
        full[1] = rev(_rot_pts(full[2], V[2], THIRD))
        full[3] = rev(_rot_pts(full[4], V[4], THIRD))
        full[5] = rev(_rot_pts(full[0], V[0], THIRD))
    outline = np.vstack([full[e][1:] for e in range(ne)])
    return Shape(kind, f, outline, [len(full[e]) - 1 for e in range(ne)])


def shape_of(sp: Species) -> Shape:
    return blend(sp, sp, 0.0)


def control_points(sp: Species, shape: Shape) -> dict[int, tuple[str, F64]]:
    """Each free edge's control points (interior) in the tile frame, for drawing handles."""
    out = {}
    ne = TYPES[sp.type].edges
    for e, (name, ctrl) in sp.controls.items():
        A, B = shape.frame.V[e], shape.frame.V[(e + 1) % ne]
        d = B - A
        perp = np.array([-d[1], d[0]])
        pts = A + ctrl[:, :1] * d + ctrl[:, 1:] * perp if len(ctrl) else np.zeros((0, 2))
        out[e] = (name, pts)
    return out


def species_files(root: Path = TILES) -> list[Path]:
    return sorted(p for p in root.glob("*/*.json") if p.name != "index.json")
