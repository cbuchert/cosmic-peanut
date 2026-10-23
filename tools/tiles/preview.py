"""Preview sheets: the tile with its control points, tiled patches in two palettes, and morph
strips to each compatible species (or to the plain tile, the path of a change of type)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import check
from . import geometry as g
from .geometry import TYPES, Species
from .raster import ERODE, draw_disc, draw_line, draw_text, locate, render, write_png

BLUE = (0.12, 0.35, 0.85)
ORANGE = (0.95, 0.45, 0.05)
GREY = (0.45, 0.45, 0.45)
RED = (0.85, 0.1, 0.1)
INK = (0.08, 0.08, 0.08)


def _shade(shape, art, centre, span, size, palette, ss):
    w, h = size
    ox = centre[0] - span / 2
    oy = centre[1] - span * h / w / 2
    img = render(shape, art, (ox, oy), span, (w * ss, h * ss), palette, ink_px=1.6 * ss)
    if ss > 1:
        img = img.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    return img, (ox, oy)


def _tile_panel(sp: Species, size: int, ss: int) -> np.ndarray:
    shape = g.shape_of(sp)
    lo, hi = shape.outline.min(0), shape.outline.max(0)
    centre = (lo + hi) / 2
    span = float(max(hi - lo)) * 1.45
    img, (ox, oy) = _shade(shape, [(sp.prims, 0.0)], centre, span, (size, size), "four-block", ss)
    # Fade everything but the base tile.
    px = span / size
    xs = ox + (np.arange(size) + 0.5) * px
    ys = oy + (np.arange(size)[::-1] + 0.5) * px
    gx, gy = np.meshgrid(xs, ys)
    h = locate(shape, np.column_stack([gx.ravel(), gy.ravel()]))
    base = ((h.k == 0) & (h.i == 0) & (h.j == 0)).reshape(size, size)
    img[~base] = img[~base] * 0.3 + 0.7

    def to_px(p):
        p = np.atleast_2d(p)
        return np.column_stack([(p[:, 0] - ox) / px, size - (p[:, 1] - oy) / px])

    info = TYPES[sp.type]
    ne = info.edges
    for e in range(ne):
        pts = to_px(shape.edge(e))
        free = e in info.free
        draw_line(img, pts, 3.2 if free else 2.0, BLUE if free else GREY, dash=0 if free else 6)
        mid = pts[len(pts) // 2]
        draw_text(img, int(mid[0]) + 6, int(mid[1]) + 4, f"E{e}", 2, BLUE if free else GREY)
    for v in range(ne):
        p = to_px(shape.frame.V[v])[0]
        draw_disc(img, p[0], p[1], 5, INK)
        draw_text(img, int(p[0]) + 7, int(p[1]) - 18, f"V{v}", 2, INK)
    for e, (kind, ctrl) in g.control_points(sp, shape).items():
        if not len(ctrl):
            continue
        cp = to_px(ctrl)
        ends = to_px(np.vstack([shape.frame.V[e], shape.frame.V[(e + 1) % ne]]))
        if kind == "bezier":
            chain = np.vstack([ends[0], cp, ends[1]])
            for s in range(0, len(chain) - 1, 3):
                draw_line(img, chain[s : s + 2], 1.2, ORANGE)
                draw_line(img, chain[s + 2 : s + 4], 1.2, ORANGE)
            for i, p in enumerate(cp):
                anchor = (i + 1) % 3 == 0
                draw_disc(img, p[0], p[1], 4.5 if anchor else 3.5, BLUE if anchor else ORANGE)
        else:
            for p in cp:
                draw_disc(img, p[0], p[1], 4.5, BLUE)
        for i, p in enumerate(cp):
            draw_text(img, int(p[0]) + 5, int(p[1]) + 5, str(i), 1, INK)
    return img


def _patch(shape, art, palette, size, ss, tiles=4.0):
    lo, hi = shape.outline.min(0), shape.outline.max(0)
    area = abs(np.linalg.det(shape.frame.L)) / TYPES[shape.type].copies
    span = tiles * math.sqrt(area)
    img, _ = _shade(shape, art, (lo + hi) / 2, span, (size, size), palette, ss)
    return img


def _strip(a: Species, b: Species, size: int, ss: int) -> np.ndarray:
    frames = []
    for w in (0, 0.25, 0.5, 0.75, 1):
        shape = g.blend(a, b, w)
        art = [(a.prims, w * ERODE), (b.prims, (1 - w) * ERODE)]
        frames.append(_patch(shape, art, "ochre", size, ss, tiles=2.6))
        frames.append(np.ones((size, 8, 3)))
    return np.hstack(frames[:-1])


def sheet(sp: Species, species: list[Species], out: Path, fast: bool = False) -> Path:
    ss = 1
    big = 360 if fast else 640
    small = 180 if fast else 300
    pad = 16
    issues = check.check_species(sp)
    errs = [i for i in issues if i.level == "error"]
    shape = g.shape_of(sp)
    # Draw whenever the outline itself is valid (art errors are what a designer needs to see).
    drawable = not check.check_outline(shape, sp.id)
    half = (big - pad) // 2
    blank = np.ones((half, half, 3))
    tile = _tile_panel(sp, big, ss) if drawable else np.ones((big, big, 3))
    p1 = _patch(shape, [(sp.prims, 0.0)], "four-block", half, ss) if drawable else blank
    p2 = _patch(shape, [(sp.prims, 0.0)], "ink", half, ss) if drawable else blank
    partners = [o for o in species if o.sig == sp.sig and o.id != sp.id][:3]
    strips = [(o.id, _strip(sp, o, small, ss)) for o in partners] if drawable else []
    if drawable and not partners:
        strips = [("plain tile (type change path)", _strip(sp, g.plain_of(sp), small, ss))]

    width = max([big + 2 * half + 4 * pad + 200, *(s.shape[1] + 2 * pad for _, s in strips)])
    head = 70
    height = head + big + pad + sum(s.shape[0] + 34 for _, s in strips) + pad
    img = np.full((height, width, 3), 0.97)
    draw_text(img, pad, 12, f"{sp.name}  {sp.id}  {sp.type}", 3, INK)
    status = "CHECK OK" if not errs else f"CHECK FAILED: {len(errs)} ERROR(S)"
    warns = [i for i in issues if i.level == "warning"]
    if warns:
        status += f", {len(warns)} WARNING(S)"
    draw_text(img, pad, 44, f"{sp.sig}   {status}", 2, RED if errs else INK)
    y = head
    img[y : y + big, pad : pad + big] = tile
    x2 = pad + big + pad
    img[y : y + half, x2 : x2 + half] = p1
    img[y + half + pad : y + 2 * half + pad, x2 : x2 + half] = p2
    draw_text(img, x2 + half + 10, y + 4, "FOUR-BLOCK", 2, INK)
    draw_text(img, x2 + half + 10, y + half + pad + 4, "INK", 2, INK)
    tx, ty = x2 + half + 10, y + half + pad + 40
    for i in (errs + warns)[:24]:
        for ln in _wrap(i.msg.split(": ", 1)[-1], 34):
            draw_text(img, tx, ty, ln, 1, RED if i.level == "error" else ORANGE)
            ty += 11
        ty += 5
    y += big + pad
    for label, s in strips:
        draw_text(img, pad, y + 8, f"MORPH TO {label}:  0  25  50  75  100 %", 2, INK)
        y += 30
        img[y : y + s.shape[0], pad : pad + s.shape[1]] = s
        y += s.shape[0] + 4
    path = out / f"{sp.id.replace('/', '-')}.png"
    write_png(path, img)
    return path


def _wrap(s: str, n: int) -> list[str]:
    words, lines, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > n:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return [*lines, cur] if cur else lines
