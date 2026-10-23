// @ts-check
/**
 * Tiling engine for the tessellation visualizers (Metamorphosis and the ones after it).
 *
 * A wallpaper group (p4 or p3) tiles the plane with regular tiles (half-unit squares, or the
 * rhombi of the tumbling-blocks pattern). A smooth displacement field d with the group's symmetry
 * (d(Rp) = R d(p), d(p + e) = d(p)) warps the coordinates before the regular tile test, so the
 * tiles become interlocking shapes with hooks and lobes. While the field's Lipschitz constant is
 * below 1, p ↦ p + d(p) is a homeomorphism, so the warped tiles still tile: no gaps, no overlaps.
 *
 * The field is a sum of base terms A cos(2π k·p + φ), each symmetrized over the group's
 * rotations: the orbit R^r k with amplitude R^r A. `groupOf` fixes the k and φ of every term
 * (uploaded once); `expandAmps` turns a motif's per-base-term amplitudes into the per-term
 * vectors the shader sums. `warpAt` mirrors the shader's sum for the tests.
 */

const TAU = 2 * Math.PI;
const S3 = Math.sqrt(3);

/**
 * @typedef {object} Group
 * @property {string} name "p4" or "p3"
 * @property {number} order rotation order about the origin (4 or 3)
 * @property {number[][]} basis lattice basis vectors
 * @property {{ k: number[], phase: number }[]} terms base terms (before symmetrizing)
 * @property {number} n terms after symmetrizing (terms × order)
 * @property {Float32Array} k per symmetrized term: kx, ky, phase, 0 (uniform4fv-ready)
 */

/** @type {Record<string, { order: number, basis: number[][], terms: { k: number[], phase: number }[] }>} */
const DEFS = {
  // Square lattice, 90° rotations. R² = −1 makes the field odd, so every term is a sine.
  p4: {
    order: 4,
    basis: [
      [1, 0],
      [0, 1],
    ],
    terms: [
      { k: [1, 0], phase: -Math.PI / 2 },
      { k: [1, 1], phase: -Math.PI / 2 },
      { k: [2, 1], phase: -Math.PI / 2 },
      { k: [1, 2], phase: -Math.PI / 2 },
      { k: [2, 0], phase: -Math.PI / 2 },
    ],
  },
  // Hex lattice, 120° rotations. Dual-lattice wave vectors (k·e integer); no 180° rotation, so
  // each shell needs a cosine and a sine.
  p3: {
    order: 3,
    basis: [
      [1, 0],
      [0.5, S3 / 2],
    ],
    terms: [
      { k: [0, 2 / S3], phase: 0 },
      { k: [0, 2 / S3], phase: Math.PI / 2 },
      { k: [2, 0], phase: 0 },
      { k: [2, 0], phase: Math.PI / 2 },
      { k: [0, 4 / S3], phase: 0 },
      { k: [0, 4 / S3], phase: Math.PI / 2 },
    ],
  },
};

/** @type {Record<string, Group>} */
const CACHE = {};

/** The group by name; unknown names → p4. @param {unknown} name @returns {Group} */
export function groupOf(name) {
  const key = name === "p3" ? "p3" : "p4";
  if (CACHE[key]) return CACHE[key];
  const d = DEFS[key];
  const n = d.terms.length * d.order;
  const k = new Float32Array(n * 4);
  d.terms.forEach((t, i) => {
    for (let r = 0; r < d.order; r++) {
      const a = (TAU * r) / d.order;
      const j = (i * d.order + r) * 4;
      k[j] = Math.cos(a) * t.k[0] - Math.sin(a) * t.k[1];
      k[j + 1] = Math.sin(a) * t.k[0] + Math.cos(a) * t.k[1];
      k[j + 2] = t.phase;
    }
  });
  CACHE[key] = { name: key, order: d.order, basis: d.basis, terms: d.terms, n, k };
  return CACHE[key];
}

/**
 * Symmetrize a motif: per base term, an amplitude given along its wave vector (l) and across it
 * (t), turned by `theta`, becomes `order` vectors R^r A. Turning every A by the same angle keeps
 * the field symmetric (rotations commute) and keeps its Lipschitz bound.
 * @param {Group} g
 * @param {ArrayLike<number>} base per base term: l, t
 * @param {number} theta radians
 * @param {Float32Array} out length ≥ g.n × stride (Ax, Ay per symmetrized term)
 * @param {number} [stride=2] floats per term in `out` (4 to interleave two sets)
 * @param {number} [offset=0] first float written
 */
export function expandAmps(g, base, theta, out, stride = 2, offset = 0) {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  for (let i = 0; i < g.terms.length; i++) {
    const kv = g.terms[i].k;
    const kl = Math.hypot(kv[0], kv[1]);
    const ux = kv[0] / kl;
    const uy = kv[1] / kl;
    const l = base[i * 2];
    const t = base[i * 2 + 1];
    // A = l û + t û⊥, then turned by theta.
    const ax0 = l * ux - t * uy;
    const ay0 = l * uy + t * ux;
    const ax = ct * ax0 - st * ay0;
    const ay = st * ax0 + ct * ay0;
    for (let r = 0; r < g.order; r++) {
      const a = (TAU * r) / g.order;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const j = offset + (i * g.order + r) * stride;
      out[j] = c * ax - s * ay;
      out[j + 1] = s * ax + c * ay;
    }
  }
  return out;
}

/**
 * The displacement d(p) = Σ A cos(2π k·p + φ) (mirrors tess.glsl's field sum for one set).
 * @param {Group} g @param {ArrayLike<number>} amps from expandAmps (stride 2)
 * @param {number} x @param {number} y @param {number[]} out receives dx, dy
 */
export function warpAt(g, amps, x, y, out) {
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < g.n; i++) {
    const c = Math.cos(TAU * (g.k[i * 4] * x + g.k[i * 4 + 1] * y) + g.k[i * 4 + 2]);
    dx += amps[i * 2] * c;
    dy += amps[i * 2 + 1] * c;
  }
  out[0] = dx;
  out[1] = dy;
  return out;
}

/**
 * Lipschitz allowance per warp step. Below 1 the step is a homeomorphism; the margin keeps tile
 * necks from pinching to slivers.
 */
export const WARP_LIMIT = 0.85;

/**
 * @typedef {object} Blend the spatial metamorphosis between the two sets of a field:
 *   m(p) = ½ + ½ sin(2π (kx, ky)·p + phase), 0 = all set A, 1 = all set B.
 * @property {number} kx @property {number} ky @property {number} phase
 */

/** Largest |∇m| of a blend: π |k|. @param {Blend} b */
export const blendGradient = (b) => Math.PI * Math.hypot(b.kx, b.ky);

/**
 * Lipschitz bound of the blended field d = (1 − m) dA + m dB (sets interleaved, stride 4):
 * |J| ≤ max(LA, LB) + |∇m| (DA + DB), with L = Σ |A| 2π|k| and D = Σ |A| (the largest |d|).
 * @param {Group} g @param {ArrayLike<number>} ab @param {number} grad blendGradient
 */
export function blendBound(g, ab, grad) {
  let la = 0;
  let lb = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < g.n; i++) {
    const kk = TAU * Math.hypot(g.k[i * 4], g.k[i * 4 + 1]);
    const a = Math.hypot(ab[i * 4], ab[i * 4 + 1]);
    const b = Math.hypot(ab[i * 4 + 2], ab[i * 4 + 3]);
    la += a * kk;
    lb += b * kk;
    da += a;
    db += b;
  }
  return Math.max(la, lb) + grad * (da + db);
}

/**
 * Scale both sets in place so blendBound ≤ limit (fields already inside are left alone).
 * @param {Group} g @param {Float32Array} ab @param {number} grad @param {number} limit
 * @returns {number} the scale applied (≤ 1)
 */
export function fitWarp(g, ab, grad, limit) {
  const b = blendBound(g, ab, grad);
  // The margin absorbs Float32 rounding of the scaled amplitudes.
  const s = b > limit ? (limit / b) * (1 - 1e-6) : 1;
  if (s < 1) for (let i = 0; i < g.n * 4; i++) ab[i] *= s;
  return s;
}

/**
 * The blended field at p (mirrors tess.glsl `tessField`; used by the tests).
 * @param {Group} g @param {ArrayLike<number>} ab interleaved sets @param {Blend} blend
 * @param {number} x @param {number} y @param {number[]} out receives dx, dy
 */
export function fieldAt(g, ab, blend, x, y, out) {
  const m = 0.5 + 0.5 * Math.sin(TAU * (blend.kx * x + blend.ky * y) + blend.phase);
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < g.n; i++) {
    const c = Math.cos(TAU * (g.k[i * 4] * x + g.k[i * 4 + 1] * y) + g.k[i * 4 + 2]);
    dx += ((1 - m) * ab[i * 4] + m * ab[i * 4 + 2]) * c;
    dy += ((1 - m) * ab[i * 4 + 1] + m * ab[i * 4 + 3]) * c;
  }
  out[0] = dx;
  out[1] = dy;
  return out;
}

/**
 * @typedef {object} Tile the regular tile containing a point (mirrors tess.glsl `tessTile`)
 * @property {number} id unique per tile
 * @property {number} cls colour class: 0–1 (p4 checkerboard) or 0–2 (p3)
 * @property {number} orient how many group rotations take the base tile to this one
 * @property {number} u @property {number} v tile-local coordinates, 0–1 across the tile;
 *   they rotate with the tile, so features drawn at fixed (u, v) appear in every tile alike
 * @property {number} dist distance to the tile's boundary (plane units)
 * @property {number} nx @property {number} ny unit gradient of `dist` (points inward)
 */

/** @returns {Tile} */
export const createTile = () => ({ id: 0, cls: 0, orient: 0, u: 0, v: 0, dist: 0, nx: 0, ny: 0 });

/** Distance and inward normal from tile-local u, v (both groups: ½ min(u, 1−u, v, 1−v)). */
function edges(/** @type {Tile} */ t, /** @type {number[]} */ nu, /** @type {number[]} */ nv) {
  const u = t.u;
  const v = t.v;
  let d = u;
  let nx = nu[0];
  let ny = nu[1];
  if (1 - u < d) [d, nx, ny] = [1 - u, -nu[0], -nu[1]];
  if (v < d) [d, nx, ny] = [v, nv[0], nv[1]];
  if (1 - v < d) [d, nx, ny] = [1 - v, -nv[0], -nv[1]];
  t.dist = 0.5 * d;
  t.nx = nx;
  t.ny = ny;
}

const mod = (/** @type {number} */ a, /** @type {number} */ n) => ((a % n) + n) % n;
/** p4 orientation from the cell's parity: four cells turn about each integer point. */
const P4_ORIENT = [0, 1, 3, 2]; // index: (i & 1) | (j & 1) << 1
/** The p3 base rhombus's edge normals (local frame): across u (150° edge) and across v (30° edge). */
const P3_NU = [0.5, S3 / 2];
const P3_NV = [-0.5, S3 / 2];

/**
 * The regular (unwarped) tile at q.
 * p4: half-unit squares; the four around each integer point are its 90° turns (corner at the
 *   point), coloured as a checkerboard.
 * p3: each hexagon of the lattice split into three rhombi, centre to alternate corners, turned
 *   120° about the centre; the class is which of the three. Same-class tiles are lattice
 *   translates, never closer than 1, while an edge is 1/√3 long, so no two share an edge.
 * @param {Group} g @param {number} x @param {number} y @param {Tile} t
 */
export function tileAt(g, x, y, t) {
  if (g.order === 4) {
    const i = Math.floor(2 * x);
    const j = Math.floor(2 * y);
    const pi = mod(i, 2);
    const pj = mod(j, 2);
    const o = P4_ORIENT[pi | (pj << 1)];
    // The turning corner: lower-left for orientation 0, then counter-clockwise.
    const cx = (i + pi) / 2;
    const cy = (j + pj) / 2;
    const rx = x - cx;
    const ry = y - cy;
    // local = R^−o (r)
    const lx = o === 0 ? rx : o === 1 ? ry : o === 2 ? -rx : -ry;
    const ly = o === 0 ? ry : o === 1 ? -rx : o === 2 ? -ry : rx;
    t.u = 2 * lx;
    t.v = 2 * ly;
    t.orient = o;
    t.cls = (pi + pj) % 2;
    t.id = i * 100003 + j;
    edges(t, P4_N[o][0], P4_N[o][1]);
    return t;
  }
  // p3: nearest lattice point (one of the containing cell's corners), then the 120° sector.
  const b = y / (S3 / 2);
  const a = x - b / 2;
  const fa = Math.floor(a);
  const fb = Math.floor(b);
  let la = fa;
  let lb = fb;
  let best = Infinity;
  for (let da = 0; da < 2; da++) {
    for (let db = 0; db < 2; db++) {
      const px = fa + da + (fb + db) / 2;
      const py = ((fb + db) * S3) / 2;
      const d2 = (x - px) ** 2 + (y - py) ** 2;
      if (d2 < best) [best, la, lb] = [d2, fa + da, fb + db];
    }
  }
  const rx = x - (la + lb / 2);
  const ry = y - (lb * S3) / 2;
  const k = Math.floor(mod(Math.atan2(ry, rx) - Math.PI / 6, TAU) / (TAU / 3)) % 3;
  const c = Math.cos((-TAU * k) / 3);
  const s = Math.sin((-TAU * k) / 3);
  const lx = c * rx - s * ry;
  const ly = s * rx + c * ry;
  t.u = lx + S3 * ly;
  t.v = S3 * ly - lx;
  t.orient = k;
  t.cls = k;
  t.id = (la * 100003 + lb) * 3 + k;
  edges(t, P3_N[k][0], P3_N[k][1]);
  return t;
}

/** p4 edge normals per orientation (local u and v axes turned into the plane), like P3_N. */
const P4_N = [0, 1, 2, 3].map((o) => {
  const a = (TAU * o) / 4;
  return [
    [Math.cos(a), Math.sin(a)],
    [-Math.sin(a), Math.cos(a)],
  ];
});
/** p3 edge normals per orientation. */
const P3_N = [0, 1, 2].map((k) => {
  const a = (TAU * k) / 3;
  const r = (/** @type {number[]} */ [x, y]) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];
  return [r(P3_NU), r(P3_NV)];
});

/**
 * Palette slot for a colour class after `shift` figure/ground swaps, with n ≥ classes tile
 * colours: (cls + shift) mod n, so distinct classes always get distinct colours.
 * @param {number} cls @param {number} shift @param {number} n
 */
export const classColor = (cls, shift, n) => mod(cls + shift, n);

/**
 * The Droste (log-polar) map's complex scale α for a lattice vector V = a e1 + b e2: the plane
 * point is p = α log z, so going once round the centre (log z gains 2πi) moves p by α·2πi = V,
 * a lattice translation: the tiling lines up across the seam. V off the lattice axes makes the
 * tiling spiral; shifting log z along the real axis zooms without end.
 * @param {Group} g @param {number} a @param {number} b integers @param {number[]} out αx, αy
 */
export function drosteAlpha(g, a, b, out) {
  const vx = a * g.basis[0][0] + b * g.basis[1][0];
  const vy = a * g.basis[0][1] + b * g.basis[1][1];
  // V / (2πi) = (vy − i vx) / 2π
  out[0] = vy / TAU;
  out[1] = -vx / TAU;
  return out;
}

/**
 * p = α log z (mirrors metamorphosis.frag's droste space without the zoom offset).
 * @param {number[]} alpha @param {number} zx @param {number} zy @param {number[]} out
 */
export function drosteAt(alpha, zx, zy, out) {
  const wx = Math.log(Math.hypot(zx, zy));
  const wy = Math.atan2(zy, zx);
  out[0] = alpha[0] * wx - alpha[1] * wy;
  out[1] = alpha[0] * wy + alpha[1] * wx;
  return out;
}

/** Motif families, from dark (round, fish-like) to bright (hooked, bird-like). */
export const FAMILIES = ["lobed", "finned", "star", "hooked"];

/**
 * Per group and family, the base terms' amplitudes (l along k, t across it), in the order of the
 * group's terms. Original shapes, tuned by eye: lobed = low-frequency bulges along k; finned =
 * higher-frequency ripples across k; star = higher-frequency bulges (points); hooked =
 * low-frequency swirl across k (cross-k waves are divergence-free, so they curl edges into hooks).
 * Normalized below to a Lipschitz bound of 1.
 * @type {Record<string, number[][]>}
 */
const PRESETS = {
  // terms: (1,0) (1,1) (2,1) (1,2) (2,0)
  p4: [
    [1, 0.3, 0.5, 0, 0, 0.1, 0, -0.1, 0.1, 0],
    [0, 0.4, 0, 0, 0.1, 1, 0, -0.6, 0, 0.2],
    [0.2, 0, -0.6, 0, 0.3, 0, 0, 0, 1, 0],
    [0, 1, 0, 0.6, 0.3, 0, 0, 0.2, 0, 0],
  ],
  // terms: f2 cos, f2 sin, (2,0) cos, (2,0) sin, 2f2 cos, 2f2 sin
  p3: [
    [1, 0, 0.4, 0.3, 0.3, 0, 0, 0, 0, 0, 0, 0],
    [0, 0.3, 0, 0, 0, 1, 0, -0.5, 0, 0.3, 0, 0],
    [0, 0, 0.3, 0, 1, 0, 0, 0, 0.5, 0, -0.3, 0],
    [0, 1, 0.3, 0.6, 0, 0, 0, 0.3, 0, 0, 0, 0],
  ],
};

/** Lipschitz bound of base amplitudes once symmetrized: order × Σ |A| 2π|k|. @param {Group} g @param {ArrayLike<number>} base */
function baseBound(g, base) {
  let l = 0;
  g.terms.forEach((t, i) => {
    l += Math.hypot(base[i * 2], base[i * 2 + 1]) * TAU * Math.hypot(t.k[0], t.k[1]);
  });
  return l * g.order;
}

/** @type {Record<string, Float32Array[]>} */
const NORMALIZED = {};
/** @param {Group} g */
function presetsOf(g) {
  if (!NORMALIZED[g.name]) {
    NORMALIZED[g.name] = PRESETS[g.name].map((p) => {
      const s = 1 / baseBound(g, p);
      return Float32Array.from(p, (v) => v * s);
    });
  }
  return NORMALIZED[g.name];
}

/**
 * The per-frame warp: two coefficient sets (A where the spatial blend is 0, B where it is 1),
 * each a weighted mix of the families turned by an angle, fitted to `strength` × WARP_LIMIT.
 * `ab` (A.xy, B.xy per term) is uniform4fv-ready; `set` allocates nothing.
 * @param {Group} g
 */
export function createWarp(g) {
  const presets = presetsOf(g);
  const nb = g.terms.length * 2;
  const baseA = new Float32Array(nb);
  const baseB = new Float32Array(nb);
  const w = {
    ab: new Float32Array(g.n * 4),
    /** Scale applied by the last fit. */
    scale: 1,
    /**
     * @param {ArrayLike<number>} wa family weights of set A @param {number} thetaA radians
     * @param {ArrayLike<number>} wb family weights of set B @param {number} thetaB
     * @param {Blend} blend @param {number} [strength=1] 0–1 of the allowance
     */
    set(wa, thetaA, wb, thetaB, blend, strength = 1) {
      baseA.fill(0);
      baseB.fill(0);
      for (let f = 0; f < presets.length; f++) {
        const p = presets[f];
        for (let i = 0; i < nb; i++) {
          baseA[i] += wa[f] * p[i];
          baseB[i] += wb[f] * p[i];
        }
      }
      expandAmps(g, baseA, thetaA, w.ab, 4, 0);
      expandAmps(g, baseB, thetaB, w.ab, 4, 2);
      // Scale to the allowance (up as well as down): mixes keep the full creature-like depth.
      const b = blendBound(g, w.ab, blendGradient(blend));
      const s = b > 1e-9 ? ((Math.max(0, Math.min(1, strength)) * WARP_LIMIT) / b) * (1 - 1e-6) : 0;
      for (let i = 0; i < g.n * 4; i++) w.ab[i] *= s;
      w.scale = s;
      return w;
    },
  };
  return w;
}

/** Most tile colours a palette has (uniform array size in the shader). */
export const MAX_TILE_COLORS = 5;
/** Palette options (neutral names). */
export const PALETTES = ["ink", "dusk", "four-block", "ochre", "watercolour"];
/**
 * sRGB hex: paper, ink (outlines and key block), then the tile colours, which the colour classes
 * take in order and cycle through on each figure/ground shift. Palettes after the ink colours of
 * 1930s–60s woodcuts and of regular-division sketchbooks; values tuned by eye.
 * @type {Record<string, number[]>}
 */
const PALETTE_HEX = {
  ink: [0xefe7d4, 0x1c1b19, 0x2a2823, 0xece3cc, 0x9a9283],
  dusk: [0xebe4d2, 0x18191d, 0x25272d, 0xe6dfcb, 0x7c8b9c],
  "four-block": [0xede3cb, 0x1d1b18, 0xc99a36, 0x7d9068, 0x4e6a88, 0xa4503a],
  ochre: [0xefe4c8, 0x1f1b16, 0xc28a2c, 0x8a8174, 0x2b2620, 0xe9dcbc],
  watercolour: [0xf5f0e4, 0x3b3430, 0xb5573f, 0x5470ab, 0xe0c36b, 0xf3ede0],
};

/**
 * Write a palette (0–1 sRGB): paper, ink, then the tile colours, 3 floats each. Unknown → "ink".
 * @param {unknown} name @param {Float32Array} out length ≥ 6 + MAX_TILE_COLORS × 3
 * @returns {number} how many tile colours
 */
export function paletteOf(name, out) {
  const hex = PALETTE_HEX[PALETTES[Math.max(0, PALETTES.indexOf(String(name)))]];
  for (let i = 0; i < hex.length; i++) {
    out[i * 3] = ((hex[i] >> 16) & 255) / 255;
    out[i * 3 + 1] = ((hex[i] >> 8) & 255) / 255;
    out[i * 3 + 2] = (hex[i] & 255) / 255;
  }
  return hex.length - 2;
}

// ---- Relief: the carved block (mirrors tess.glsl tessRelief; tested for the march's bounds) ----

/** A resting tile's top above the groove floor, plane units at Relief 1. */
export const RELIEF_BLOCK = 0.07;
/** A bevelled tile tops out this far in from its outline (tile distance units)… */
export const RELIEF_BEVEL = 0.05;
/** …a domed one at its centre (the largest tile distance, both groups). */
export const RELIEF_DOME = 0.25;
/** Half a card's width across its turning axis (plane units): longer tips are flattened. */
export const CARD_HALF = 0.36;
/** A turning card rises this fraction of a rigid card's height: its squeeze across the axis is
 * true, its height shallow, so it never stands as a wall far above the carving. */
export const CARD_RISE = 0.3;

/** @param {number} x @param {number} w ease-out ramp 0 → 1 over w, flat at the top */
const ramp = (x, w) => {
  const u = Math.min(1, Math.max(0, x / w));
  return u * (2 - u);
};
/** @param {number} x @param {number} w */
const rampSlope = (x, w) => (x <= 0 || x >= w ? 0 : (2 / w) * (1 - x / w));

/**
 * A tile's block height (0 at the carved outline, 1 on top) from its interior distance d:
 * bevelled (profile 0: steep cut, then a flat top RELIEF_BEVEL in) to domed (1: crown at the
 * centre). @param {number} d @param {number} profile 0–1
 */
export const reliefProfile = (d, profile) => ramp(d, RELIEF_BEVEL) + (ramp(d, RELIEF_DOME) - ramp(d, RELIEF_BEVEL)) * profile;
/** d/dd of reliefProfile: at most 2 / RELIEF_BEVEL. @param {number} d @param {number} profile */
export const reliefSlope = (d, profile) =>
  rampSlope(d, RELIEF_BEVEL) + (rampSlope(d, RELIEF_DOME) - rampSlope(d, RELIEF_BEVEL)) * profile;

/**
 * Height of a card (a tile turning over about its own axis, θ 0 → π) above its bed, at card
 * coordinate x across the axis, × CARD_RISE. The axis rises to CARD_HALF + hop with sin θ so no
 * edge dips under the surface; the card is drawn unmirrored on its back (the tile seen at π is the tile
 * itself in its new colour), so the slope's sign turns over edge-on.
 * @param {number} x @param {number} theta @param {number} hop extra rise mid-turn
 */
export function cardHeight(x, theta, hop) {
  const s = Math.sin(theta);
  const xc = Math.max(-CARD_HALF, Math.min(CARD_HALF, x));
  return CARD_RISE * (s * (CARD_HALF + hop) + xc * s * (Math.cos(theta) >= 0 ? 1 : -1));
}

/**
 * @typedef {object} ReliefTile one tile's state at a point
 * @property {number} prof reliefProfile @property {number} lift beat wave + heave (plane units
 * at Relief 1, may dip a little under 0 as a spring settles) @property {number} pop onset pop
 * @property {number} theta card turn, 0–π @property {number} x card coordinate @property {number} hop
 */

/**
 * The height field (plane units) at a point (mirrors tess.glsl tessRelief): block × profile
 * (flattening as a card turns edge-on) plus lift and pop, all × Relief, plus the card.
 * @param {number} relief 0–1 @param {ReliefTile} t
 */
export function reliefHeight(relief, t) {
  const ac = Math.abs(Math.cos(t.theta));
  return Math.max(0, relief * (RELIEF_BLOCK * t.prof * ac + t.lift + t.pop) + cardHeight(t.x, t.theta, t.hop));
}

/**
 * Upper bound of reliefHeight over the plane: where a relief march starts.
 * @param {number} relief @param {number} liftMax largest lift now @param {number} popMax
 * @param {boolean} flipping a card is turning @param {number} hop
 */
export const reliefBound = (relief, liftMax, popMax, flipping, hop) =>
  relief * (RELIEF_BLOCK + Math.max(0, liftMax) + Math.max(0, popMax)) + (flipping ? CARD_RISE * (2 * CARD_HALF + hop) : 0);
