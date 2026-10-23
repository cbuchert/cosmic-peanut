"""Point location, coverage and rendering for the tile tool (numpy, no image libraries).

`locate` mirrors the bake shader's search (shaders/tess/atlas-bake.frag): every copy of the tile in
the period cell, at nearby lattice translates, whose inverse map takes the point into the base
outline. The renderer shades like the engine's atlas mode (class fills, art roles, ink outline,
distance-antialiased) so preview sheets look like the print.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from .geometry import TYPES, Prim, Shape

F64 = NDArray[np.float64]
I64 = NDArray[np.int64]

# Palettes as in plugins/builtin/src/lib/tess.js: paper, ink, then the tile colours.
PALETTES = {
    "four-block": [0xEDE3CB, 0x1D1B18, 0xC99A36, 0x7D9068, 0x4E6A88, 0xA4503A],
    "ink": [0xEFE7D4, 0x1C1B19, 0x2A2823, 0xECE3CC, 0x9A9283],
    "ochre": [0xEFE4C8, 0x1F1B16, 0xC28A2C, 0x8A8174, 0x2B2620, 0xE9DCBC],
}
ERODE = 0.12  # tile-frame units: art of the species being left erodes away by w × this


def inside_dist(poly: F64, q: F64, want_dist: bool = True) -> tuple[NDArray[np.bool_], F64]:
    """Even-odd inside test and distance to the closed polygon `poly` for points q (n, 2)."""
    x, y = q[:, 0], q[:, 1]
    ins = np.zeros(len(q), bool)
    d2 = np.full(len(q), np.inf) if want_dist else np.zeros(0)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i - 1]
        x1, y1 = poly[i]
        cross = (y1 > y) != (y0 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xc = (x0 - x1) * (y - y1) / (y0 - y1) + x1
        ins ^= cross & (x < xc)
        if want_dist:
            dx, dy = x1 - x0, y1 - y0
            ll = dx * dx + dy * dy
            t = np.clip(((x - x0) * dx + (y - y0) * dy) / ll, 0, 1) if ll > 0 else 0.0
            ex, ey = x - (x0 + t * dx), y - (y0 + t * dy)
            np.minimum(d2, ex * ex + ey * ey, out=d2)
    return ins, np.sqrt(d2) if want_dist else d2


def seg_dist(path: F64, q: F64, closed: bool) -> tuple[F64, F64]:
    """Distance to a polyline, and the path parameter (0–1 by segment index) of the nearest point."""
    best = np.full(len(q), np.inf)
    par = np.zeros(len(q))
    n = len(path)
    segs = n if closed else n - 1
    for i in range(segs):
        x0, y0 = path[i]
        x1, y1 = path[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        ll = dx * dx + dy * dy
        t = np.clip(((q[:, 0] - x0) * dx + (q[:, 1] - y0) * dy) / ll, 0, 1) if ll > 0 else 0.0
        ex, ey = q[:, 0] - (x0 + t * dx), q[:, 1] - (y0 + t * dy)
        d = np.sqrt(ex * ex + ey * ey)
        better = d < best
        best = np.where(better, d, best)
        par = np.where(better, (i + t) / max(1, segs), par)
    return best, par


@dataclass
class Located:
    k: I64  # copy (−1: none)
    i: I64
    j: I64
    local: F64  # (n, 2) base tile frame
    count: I64  # tiles holding the point
    dist: F64  # distance to the holding tile's outline (tile frame)


def locate(shape: Shape, p: F64, reach: int = 3) -> Located:
    f = shape.frame
    n = len(p)
    Linv = np.linalg.inv(f.L)
    cell = np.floor(p @ Linv.T)
    out = Located(
        np.full(n, -1),
        np.zeros(n, np.int64),
        np.zeros(n, np.int64),
        np.zeros((n, 2)),
        np.zeros(n, np.int64),
        np.full(n, np.inf),
    )
    lo, hi = shape.outline.min(0), shape.outline.max(0)
    corners = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [lo[0], hi[1]], [hi[0], hi[1]]])
    for k, M in enumerate(f.copies):
        Ainv = np.linalg.inv(M[:, :2])
        # Lattice translates d (from the point's cell) whose copy can hold a point of the cell.
        lb = (corners @ M[:, :2].T + M[:, 2]) @ Linv.T
        d_lo = np.floor(-lb.max(0)).astype(int)
        d_hi = np.ceil(1 - lb.min(0)).astype(int)
        for di in range(max(-reach, d_lo[0]), min(reach, d_hi[0]) + 1):
            for dj in range(max(-reach, d_lo[1]), min(reach, d_hi[1]) + 1):
                t = (cell + np.array([di, dj])) @ f.L.T + M[:, 2]
                local = (p - t) @ Ainv.T
                box = np.all((local >= lo) & (local <= hi), axis=1)
                idx = np.flatnonzero(box)
                if not len(idx):
                    continue
                ins, _ = inside_dist(shape.outline, local[idx], want_dist=False)
                idx = idx[ins]
                first = idx[out.count[idx] == 0]
                out.count[idx] += 1
                out.k[first] = k
                out.i[first] = cell[first, 0] + di
                out.j[first] = cell[first, 1] + dj
                out.local[first] = local[first]
    held = out.k >= 0
    _, d = inside_dist(shape.outline, out.local[held])
    out.dist[held] = d
    return out


def classes(shape: Shape, h: Located) -> I64:
    f = shape.frame
    cc = np.array(f.copy_cls)[np.maximum(h.k, 0)]
    return (cc + h.i * f.ca + h.j * f.cb) % f.nc


def art_eval(prims: list[Prim], q: F64, erode: float = 0.0) -> tuple[I64, F64]:
    """Painter's-order role (0 = fill) and distance to the nearest visible role edge."""
    role = np.zeros(len(q), np.int64)
    d_top = np.full(len(q), np.inf)
    d_above = np.full(len(q), np.inf)
    for p in prims:
        if p.kind == 2:
            sd = np.hypot(q[:, 0] - p.points[0, 0], q[:, 1] - p.points[0, 1]) - p.r
        elif p.kind == 0:
            ins, d = inside_dist(p.points, q)
            sd = np.where(ins, -d, d)
        else:
            d, t = seg_dist(p.points, q, closed=False)
            sd = d - (p.w0 + (p.w1 - p.w0) * t) / 2
        sd = sd + erode
        cover = sd < 0
        role = np.where(cover, p.role, role)
        d_top = np.where(cover, -sd, d_top)
        d_above = np.where(cover, np.inf, np.minimum(d_above, np.abs(sd)))
    return role, np.minimum(d_top, d_above)


def srgb(hexes: list[int]) -> F64:
    return np.array([[(h >> 16) & 255, (h >> 8) & 255, h & 255] for h in hexes], float) / 255


def render(
    shape: Shape,
    art: list[tuple[list[Prim], float]],
    origin: tuple[float, float],
    span: float,
    size: tuple[int, int],
    palette: str = "four-block",
    ink_px: float = 1.6,
) -> F64:
    """Shade a patch: `span` tile-frame units across `size` (w, h) px from `origin` (bottom left).
    `art` is (prims, erosion) sets in painter's order (two sets cross-fade a morph)."""
    w, h = size
    px = span / w
    xs = origin[0] + (np.arange(w) + 0.5) * px
    ys = origin[1] + (np.arange(h)[::-1] + 0.5) * px
    gx, gy = np.meshgrid(xs, ys)
    p = np.column_stack([gx.ravel(), gy.ravel()])
    h_ = locate(shape, p)
    pal = srgb(PALETTES[palette])
    paper, ink, tiles = pal[0], pal[1], pal[2:]
    nc = shape.frame.nc
    cls = classes(shape, h_)
    fill = tiles[cls % len(tiles)]
    accent = tiles[nc % len(tiles)]
    lum = (fill**2.2) @ np.array([0.2126, 0.7152, 0.0722])
    cut = np.where((lum < 0.18)[:, None], paper, ink)
    col = fill.copy()
    held = h_.k >= 0
    local = h_.local
    for prims, erode in art:
        role, d = art_eval(prims, local, erode)
        role_col = np.select(
            [(r == role)[:, None] for r in range(1, 7)],
            [
                np.broadcast_to(ink, col.shape),
                np.broadcast_to(paper, col.shape),
                cut,
                np.broadcast_to(accent, col.shape),
                fill * 0.55 + ink * 0.45,
                fill * 0.5 + paper * 0.5,
            ],
            default=fill,
        )
        # Inside a role's region: ease in over the pixel at its edge (the render supersamples).
        cov = np.clip(0.5 + d / px, 0, 1)[:, None]
        col = np.where((role > 0)[:, None], col * (1 - cov) + role_col * cov, col)
    # Ink outline.
    a = np.clip(ink_px - h_.dist / px + 0.5, 0, 1)[:, None]
    col = col * (1 - a) + ink * a
    col[~held] = ink  # exactly on a boundary: under the outline anyway
    return col.reshape(h, w, 3)


# ---- Drawing on an image (H, W, 3 floats 0–1) ---------------------------------------------------


def draw_disc(img: F64, x: float, y: float, r: float, rgb: tuple[float, float, float]) -> None:
    h, w, _ = img.shape
    x0, x1 = max(0, int(x - r - 2)), min(w, int(x + r + 3))
    y0, y1 = max(0, int(y - r - 2)), min(h, int(y + r + 3))
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1] + 0.5
    a = np.clip(r - np.hypot(xx - x, yy - y) + 0.5, 0, 1)[..., None]
    img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - a) + np.array(rgb) * a


def draw_line(
    img: F64, pts: F64, width: float, rgb: tuple[float, float, float], dash: float = 0
) -> None:
    """Antialiased polyline in pixel coordinates (x right, y down)."""
    h, w, _ = img.shape
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        bx0, bx1 = max(0, int(min(x0, x1) - width - 2)), min(w, int(max(x0, x1) + width + 3))
        by0, by1 = max(0, int(min(y0, y1) - width - 2)), min(h, int(max(y0, y1) + width + 3))
        if bx0 >= bx1 or by0 >= by1:
            continue
        yy, xx = np.mgrid[by0:by1, bx0:bx1] + 0.5
        dx, dy = x1 - x0, y1 - y0
        ll = dx * dx + dy * dy
        t = np.clip(((xx - x0) * dx + (yy - y0) * dy) / ll, 0, 1) if ll > 0 else 0 * xx
        d = np.hypot(xx - (x0 + t * dx), yy - (y0 + t * dy))
        a = np.clip(width / 2 - d + 0.5, 0, 1)
        if dash:
            along = t * math.sqrt(ll)
            a = a * ((along % (2 * dash)) < dash)
        a = a[..., None]
        img[by0:by1, bx0:bx1] = img[by0:by1, bx0:bx1] * (1 - a) + np.array(rgb) * a


# 5×7 bitmap font: uppercase, digits and a little punctuation (rows top to bottom, 5 bits each).
_FONT = {
    "A": "0E 11 11 1F 11 11 11", "B": "1E 11 11 1E 11 11 1E", "C": "0E 11 10 10 10 11 0E",
    "D": "1E 11 11 11 11 11 1E", "E": "1F 10 10 1E 10 10 1F", "F": "1F 10 10 1E 10 10 10",
    "G": "0E 11 10 17 11 11 0F", "H": "11 11 11 1F 11 11 11", "I": "0E 04 04 04 04 04 0E",
    "J": "07 02 02 02 02 12 0C", "K": "11 12 14 18 14 12 11", "L": "10 10 10 10 10 10 1F",
    "M": "11 1B 15 15 11 11 11", "N": "11 11 19 15 13 11 11", "O": "0E 11 11 11 11 11 0E",
    "P": "1E 11 11 1E 10 10 10", "Q": "0E 11 11 11 15 12 0D", "R": "1E 11 11 1E 14 12 11",
    "S": "0F 10 10 0E 01 01 1E", "T": "1F 04 04 04 04 04 04", "U": "11 11 11 11 11 11 0E",
    "V": "11 11 11 11 11 0A 04", "W": "11 11 11 15 15 15 0A", "X": "11 11 0A 04 0A 11 11",
    "Y": "11 11 0A 04 04 04 04", "Z": "1F 01 02 04 08 10 1F", "0": "0E 11 13 15 19 11 0E",
    "1": "04 0C 04 04 04 04 0E", "2": "0E 11 01 02 04 08 1F", "3": "1F 02 04 02 01 11 0E",
    "4": "02 06 0A 12 1F 02 02", "5": "1F 10 1E 01 01 11 0E", "6": "06 08 10 1E 11 11 0E",
    "7": "1F 01 02 04 08 08 08", "8": "0E 11 11 0E 11 11 0E", "9": "0E 11 11 0F 01 02 0C",
    ".": "00 00 00 00 00 0C 0C", ",": "00 00 00 00 0C 04 08", ":": "00 0C 0C 00 0C 0C 00",
    "-": "00 00 00 1F 00 00 00", "/": "01 01 02 04 08 10 10", "=": "00 00 1F 00 1F 00 00",
    "(": "02 04 08 08 08 04 02", ")": "08 04 02 02 02 04 08", " ": "00 00 00 00 00 00 00",
    "+": "00 04 04 1F 04 04 00", "!": "04 04 04 04 04 00 04", "%": "18 19 02 04 08 13 03",
    "_": "00 00 00 00 00 00 1F", "?": "0E 11 01 02 04 00 04", ">": "08 04 02 01 02 04 08",
    "<": "02 04 08 10 08 04 02", "'": "04 04 08 00 00 00 00", "#": "0A 0A 1F 0A 1F 0A 0A",
}  # fmt: skip


def draw_text(img: F64, x: int, y: int, text: str, scale: int = 2, rgb=(0.1, 0.1, 0.1)) -> None:
    """Bitmap text, top-left at (x, y) px; unknown characters print as '?'."""
    h, w, _ = img.shape
    cx = x
    for ch in text.upper():
        rows = _FONT.get(ch, _FONT["?"]).split()
        for r, hexrow in enumerate(rows):
            bits = int(hexrow, 16)
            for c in range(5):
                if bits & (1 << (4 - c)):
                    y0, x0 = y + r * scale, cx + c * scale
                    if 0 <= y0 < h - scale and 0 <= x0 < w - scale:
                        img[y0 : y0 + scale, x0 : x0 + scale] = rgb
        cx += 6 * scale


def write_png(path: Path, img: F64) -> None:
    """8-bit RGB PNG from floats 0–1 (H, W, 3)."""
    a = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def type_scale(kind: str) -> float:
    return TYPES[kind].scale
