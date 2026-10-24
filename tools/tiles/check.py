"""Checks for species files: edge relations, a simple outline, an exact cover of the plane, art
inside the outline, valid blends between compatible species, and up-to-date group indexes."""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import geometry as g
from .geometry import TYPES, Shape, Species, SpeciesError
from .raster import inside_dist, locate, seg_dist

NECK = 0.025  # plane units (~8 px at Metamorphosis' 1440p scale): thinner warns
BLEND_STEPS = (0.25, 0.5, 0.75)
PX_PER_UNIT = 313  # Metamorphosis at 1440p: plane units → screen px


@dataclass
class Issue:
    level: str  # "error" | "warning"
    where: str  # species id or file
    msg: str

    def __str__(self) -> str:
        return f"{self.level}: {self.msg}"


def _at(p) -> str:
    return f"({p[0]:.3f}, {p[1]:.3f})"


def crossings(poly: np.ndarray) -> list[tuple[int, int]]:
    """Pairs of non-adjacent segments of the closed polygon that touch or cross."""
    n = len(poly)
    a = poly
    b = np.roll(poly, -1, axis=0)
    d = b - a

    def orient(p, q, r):
        return (q[..., 0] - p[..., 0]) * (r[..., 1] - p[..., 1]) - (q[..., 1] - p[..., 1]) * (
            r[..., 0] - p[..., 0]
        )

    A, B = a[:, None], b[:, None]
    C, D = a[None, :], b[None, :]
    o1, o2 = orient(A, B, C), orient(A, B, D)
    o3, o4 = orient(C, D, A), orient(C, D, B)
    hit = (o1 * o2 <= 0) & (o3 * o4 <= 0)
    # Collinear but separate segments pass the sign test; require overlapping boxes too.
    lo1, hi1 = np.minimum(A, B), np.maximum(A, B)
    lo2, hi2 = np.minimum(C, D), np.maximum(C, D)
    hit &= np.all((lo1 <= hi2) & (lo2 <= hi1), axis=-1)
    i, j = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    adjacent = (np.abs(i - j) <= 1) | (np.abs(i - j) == n - 1)
    zero = np.hypot(d[:, 0], d[:, 1]) < 1e-12
    hit &= ~adjacent & (i < j) & ~zero[:, None] & ~zero[None, :]
    return [(int(x), int(y)) for x, y in zip(*np.nonzero(hit), strict=True)]


def _edge_of(shape: Shape, i: int) -> int:
    k = 0
    for e, n in enumerate(shape.edge_n):
        k += n
        if i < k:
            return e
    return len(shape.edge_n) - 1


def check_outline(shape: Shape, where: str) -> list[Issue]:
    out: list[Issue] = []
    p = shape.outline
    if len(p) > g.MAX_OUTLINE:
        out.append(
            Issue("error", where, f"{where}: {len(p)} outline points (most is {g.MAX_OUTLINE})")
        )
    seg = np.hypot(*(np.roll(p, -1, axis=0) - p).T)
    for i in np.flatnonzero(seg < 1e-9):
        out.append(Issue("error", where, f"{where}: the outline repeats a point at {_at(p[i])}"))
    cr = crossings(p)
    if cr:
        i, j = cr[0]
        more = f" (and {len(cr) - 1} more)" if len(cr) > 1 else ""
        out.append(
            Issue(
                "error",
                where,
                f"{where}: the outline crosses itself: e{_edge_of(shape, i)} meets "
                f"e{_edge_of(shape, j)} near {_at(p[i])}{more}. A tile must be a simple polygon.",
            )
        )
        return out
    area = 0.5 * float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))
    cell = abs(float(np.linalg.det(shape.frame.L))) / TYPES[shape.type].copies
    if area <= 0:
        out.append(Issue("error", where, f"{where}: the outline runs clockwise (corners swapped?)"))
    elif not math.isclose(area, cell, rel_tol=1e-6):
        out.append(Issue("error", where, f"{where}: area {area:.5f} ≠ {cell:.5f} (cell / copies)"))
    return out


def check_neck(shape: Shape, where: str) -> list[Issue]:
    """Warn where the outline comes very close to itself far along it (a neck or long spike)."""
    scale = TYPES[shape.type].scale
    neck = NECK / scale
    p = shape.outline
    pts = []  # densified, so a long straight segment can't hide a close approach
    for i in range(len(p)):
        a, b = p[i - 1], p[i]
        n = max(1, math.ceil(float(np.hypot(*(b - a))) / (neck / 3)))
        pts.append(a + (b - a) * (np.arange(n) / n)[:, None])
    q = np.vstack(pts)
    arc = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(q, axis=0).T))])
    total = arc[-1] + float(np.hypot(*(q[0] - q[-1])))
    d = np.hypot(q[:, None, 0] - q[None, :, 0], q[:, None, 1] - q[None, :, 1])
    gap = np.abs(arc[:, None] - arc[None, :])
    gap = np.minimum(gap, total - gap)
    bad = (d < neck) & (gap > 4 * neck)
    if not bad.any():
        return []
    i, j = np.unravel_index(np.argmin(np.where(bad, d, np.inf)), d.shape)
    px = d[i, j] * scale * PX_PER_UNIT
    return [
        Issue(
            "warning",
            where,
            f"{where}: thin neck or spike near {_at((q[i] + q[j]) / 2)}: the outline comes within "
            f"{d[i, j]:.3f} of itself (~{px:.0f} px on a 1440p screen); it breaks up when small",
        )
    ]


def check_relations(shape: Shape, where: str) -> list[Issue]:
    """The derived edges match their partners' isometric images (true by construction)."""
    V = shape.frame.V
    kind = shape.type
    Map = Callable[[np.ndarray], np.ndarray]

    def rotation(c: np.ndarray, a: float) -> Map:
        m = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        return lambda p: c + (p - c) @ m.T

    def shift(t: np.ndarray) -> Map:
        return lambda p: p + t

    def glide(p: np.ndarray) -> np.ndarray:
        return np.column_stack([V[2, 0] - p[:, 0], p[:, 1] + V[2, 1]])

    rel: list[tuple[int, int, Map, bool, str]]
    if kind == "TTTTTT":
        rel = [
            (3, 0, shift(V[3] - V[1]), True, "translated"),
            (4, 1, shift(V[4] - V[2]), True, "translated"),
            (5, 2, shift(V[5] - V[3]), True, "translated"),
        ]
    elif kind == "TGTG":
        rel = [(2, 0, glide, False, "glided"), (3, 1, shift(-V[1] * [1, 0]), True, "translated")]
    elif kind == "C4":
        rel = [
            (2, 1, rotation(V[2], -math.pi / 2), True, "turned about V2"),
            (3, 0, rotation(V[0], math.pi / 2), True, "turned about V0"),
        ]
    else:
        rel = [
            (1, 2, rotation(V[2], g.THIRD), True, "turned about V2"),
            (3, 4, rotation(V[4], g.THIRD), True, "turned about V4"),
            (5, 0, rotation(V[0], g.THIRD), True, "turned about V0"),
        ]
    out = []
    for d, f, m, rev, how in rel:
        want = m(shape.edge(f))
        if rev:
            want = want[::-1]
        got = shape.edge(d)
        err = float(np.max(np.hypot(*(want - got).T))) if len(want) == len(got) else math.inf
        if err > 1e-9:
            out.append(Issue("error", where, f"{where}: e{d} is not e{f} {how} (off by {err:.3g})"))
    return out


def check_coverage(shape: Shape, where: str, n: int = 2, res: int = 40) -> list[Issue]:
    """Sample an n × n patch of period cells (jittered grid): every point in exactly one tile."""
    rng = np.random.default_rng(1)
    m = n * res
    grid = np.stack(np.meshgrid(np.arange(m), np.arange(m)), -1).reshape(-1, 2)
    uv = (grid + rng.random((m * m, 2))) / res
    p = uv @ shape.frame.L.T
    h = locate(shape, p)
    out = []
    gaps = np.flatnonzero(h.count == 0)
    over = np.flatnonzero(h.count > 1)
    if len(gaps):
        msg = f"{where}: gap at {_at(p[gaps[0]])} ({len(gaps)} of {m * m} samples in no tile)"
        out.append(Issue("error", where, msg))
    if len(over):
        k = int(h.count[over[0]])
        msg = f"{where}: overlap at {_at(p[over[0]])}: {k} tiles there ({len(over)} samples)"
        out.append(Issue("error", where, msg))
    return out


def _densify(p: np.ndarray, closed: bool, step: float = 0.01) -> np.ndarray:
    pts = []
    n = len(p)
    for i in range(n if closed else n - 1):
        a, b = p[i], p[(i + 1) % n]
        k = max(1, math.ceil(float(np.hypot(*(b - a))) / step))
        pts.append(a + (b - a) * (np.arange(k) / k)[:, None])
    if not closed:
        pts.append(p[-1:])
    return np.vstack(pts)


def check_art(sp: Species, shape: Shape) -> list[Issue]:
    """Every art primitive lies inside the outline (strokes by their half width)."""
    out = []
    poly = shape.outline
    for pr in sp.prims:
        name = f"{sp.id}: art[{pr.index}] (part {pr.part})"
        if pr.kind == 2:
            q = pr.points
            pad: np.ndarray | float = pr.r
        else:
            q = _densify(pr.points, pr.kind == 0)
            pad = 0.0
        ins, d = inside_dist(poly, q)
        if pr.kind == 1:
            _, t = seg_dist(pr.points, q, closed=False)
            pad = (pr.w0 + (pr.w1 - pr.w0) * t) / 2
        if pr.kind == 0:
            oin, _ = inside_dist(pr.points, poly, want_dist=False)
            if oin.any():
                at = _at(poly[int(np.argmax(oin))])
                out.append(Issue("error", sp.id, f"{name} leaves the outline (it dips in at {at})"))
                continue
        bad = ~ins | (d < pad)
        if np.any(bad):
            k = int(np.argmax(bad))
            out.append(Issue("error", sp.id, f"{name} leaves the outline near {_at(q[k])}"))
        elif pr.kind == 1 and max(pr.w0, pr.w1) * TYPES[sp.type].scale * PX_PER_UNIT < 1:
            out.append(
                Issue("warning", sp.id, f"{name}: a stroke this thin is under 1 px on screen")
            )
    return out


def check_height(sp: Species) -> list[Issue]:
    h = sp.raw.get("height") or {}
    out = []
    if not 0 <= sp.dome <= 1:
        out.append(Issue("error", sp.id, f"{sp.id}: height.dome must be 0–1"))
    for part, v in (h.get("parts") or {}).items():
        if not any(p.part == part for p in sp.prims):
            out.append(
                Issue("error", sp.id, f"{sp.id}: height.parts.{part}: no art uses this part")
            )
        elif not isinstance(v, int | float) or not -1 <= v <= 1:
            msg = f"{sp.id}: height.parts.{part} must be −1 (carved) … 1 (raised)"
            out.append(Issue("error", sp.id, msg))
    return out


def check_species(sp: Species) -> list[Issue]:
    shape = g.shape_of(sp)
    out = check_outline(shape, sp.id)
    if any(i.level == "error" for i in out):
        return out
    out += check_relations(shape, sp.id)
    out += check_coverage(shape, sp.id)
    out += check_neck(shape, sp.id)
    out += check_art(sp, shape)
    out += check_height(sp)
    return out


def compatible(species: list[Species]) -> list[list[str]]:
    """Species ids grouped by edge structure: each group blends (morphs) among itself."""
    groups: dict[str, list[str]] = {}
    for sp in species:
        groups.setdefault(sp.sig, []).append(sp.id)
    return list(groups.values())


def check_blends(species: list[Species]) -> list[Issue]:
    """Blends between compatible species, and each species with its plain tile (the runtime's
    path for a change of tile type), stay valid tiles."""
    out = []
    pairs = [(a, b) for i, a in enumerate(species) for b in species[i + 1 :] if a.sig == b.sig]
    pairs += [(sp, g.plain_of(sp)) for sp in species]
    for a, b in pairs:
        for w in BLEND_STEPS:
            bad = [i for i in check_outline(g.blend(a, b, w), a.id) if i.level == "error"]
            if bad:
                other = "its plain tile" if b.id.endswith("~plain") else b.id
                why = bad[0].msg.split(": ", 1)[1]
                msg = (
                    f"{a.id} ↔ {other}: the {w:.0%} blend is not a valid tile ({why}) "
                    "Metamorphosis passes through it: move control points so they correspond "
                    "(same order, similar places)."
                )
                out.append(Issue("error", a.id, msg))
                break
    return out


def index_of(group_dir: Path) -> dict:
    return {"species": sorted(p.stem for p in group_dir.glob("*.json") if p.name != "index.json")}


def check_index(root: Path) -> list[Issue]:
    out = []
    for gd in sorted(p for p in root.iterdir() if p.is_dir()):
        f = gd / "index.json"
        have = json.loads(f.read_text()) if f.is_file() else None
        if have != index_of(gd):
            msg = f"{gd.name}/index.json is out of date (run `uv run python -m tools.tiles index`)"
            out.append(Issue("error", str(f), msg))
    return out


def write_indexes(root: Path) -> list[Path]:
    written = []
    for gd in sorted(p for p in root.iterdir() if p.is_dir()):
        f = gd / "index.json"
        text = json.dumps(index_of(gd), indent=2) + "\n"
        if not f.is_file() or f.read_text() != text:
            f.write_text(text)
            written.append(f)
    return written


def load_all(root: Path, only: list[str] | None = None) -> tuple[list[Species], list[Issue]]:
    species, issues = [], []
    for p in g.species_files(root):
        sid = f"{p.parent.name}/{p.stem}"
        if only and sid not in only:
            continue
        try:
            species.append(g.load(p))
        except SpeciesError as e:
            issues.append(Issue("error", sid, str(e)))
    return species, issues


def check_all(root: Path = g.TILES, only: list[str] | None = None) -> list[Issue]:
    """Every check over the tiles folder (`only`: just these ids, plus their blends)."""
    species, issues = load_all(root)
    for sp in species:
        if not only or sp.id in only:
            issues += check_species(sp)
    failed = {i.where for i in issues if i.level == "error"}
    issues += check_blends([sp for sp in species if sp.id not in failed])
    issues += check_index(root)
    if only:
        keep = set(only)
        issues = [
            i
            for i in issues
            if i.where in keep or i.where.endswith("index.json") or any(o in i.msg for o in keep)
        ]
    return issues
