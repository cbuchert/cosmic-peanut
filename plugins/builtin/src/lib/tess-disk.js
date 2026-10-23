// @ts-check
/**
 * Hyperbolic tessellation for the Poincaré Disk visualizer: a {p,q} tiling's kites, deformed
 * into interlocking creatures, coloured, and seen through a drifting view. The shader is
 * shaders/tess/disk.frag; this module holds everything it needs from the CPU and mirrors its
 * maths for the tests.
 *
 * Tiles. The {p,q} triangle group's fundamental triangle T (lib/hyperbolic.js tiling(): angle
 * π/p at the centre O, π/2 at the edge midpoint M, π/q at the vertex V) and its mirror image
 * across O–V make a kite O, M, V, M'. The kites are the fundamental domains of the rotation
 * subgroup, exactly as the engine's p4 half-squares are for (2,4,4): every kite is the image of
 * one, so an asymmetric creature drawn in it repeats everywhere, turning with its kite.
 *
 * Colours. A tile's colour must come from where the fold took it, but the fold reads its word
 * of mirrors back to front. So the shader tracks the word in a finite quotient of the triangle
 * group — 2×2 matrices mod a small prime r (PGL(2, r)), one matrix product per fold step — and
 * looks the result up in a table of a proper 3-colouring of the quotient's kite graph. Kites
 * that share an edge differ by ρ±1 or τ±1 (the turns about O and V), which are never trivial in
 * the quotient, so the colouring lifts to a proper colouring of the whole infinite tiling.
 */

import { FOLD_ITERATIONS, tiling } from "./hyperbolic.js";

export const TILINGS = ["{7,3}", "{5,4}", "{4,5}", "{6,4}"];

/** {p,q} of a Tiling option; unknown → {7,3}. @param {unknown} name @returns {[number, number]} */
export function tilingPQ(name) {
  const s = TILINGS.includes(String(name)) ? String(name) : TILINGS[0];
  return [Number(s[1]), Number(s[3])];
}

/**
 * Mirrors a (the real axis), b (the line at angle π/p) and c (the circle C) as matrices of
 * PGL(2, r): involutions with ab of order p, bc of order q and ac of order 2, so they define a
 * homomorphism from the triangle group. Found by a search over the smallest primes whose kite
 * graph is 3-colourable with all three colours well used (see NOTES.md).
 * @type {Record<string, { r: number, A: number[], B: number[], C: number[] }>}
 */
const QUOTIENTS = {
  "{7,3}": { r: 7, A: [0, 1, 1, 0], B: [1, 0, 2, 6], C: [1, 5, 2, 6] },
  "{5,4}": { r: 5, A: [0, 1, 1, 0], B: [1, 0, 2, 4], C: [1, 3, 2, 4] },
  "{4,5}": { r: 5, A: [0, 1, 2, 0], B: [0, 1, 1, 0], C: [1, 1, 3, 4] },
  "{6,4}": { r: 7, A: [0, 1, 1, 0], B: [0, 1, 3, 0], C: [1, 3, 4, 6] },
};

/**
 * out = x·y mod r (2×2, row-major a b c d, entries 0…r−1); out may alias x or y.
 * @param {number} r @param {ArrayLike<number>} x @param {ArrayLike<number>} y @param {Int32Array} out
 */
export function matMul(r, x, y, out) {
  const a = (x[0] * y[0] + x[1] * y[2]) % r;
  const b = (x[0] * y[1] + x[1] * y[3]) % r;
  const c = (x[2] * y[0] + x[3] * y[2]) % r;
  const d = (x[2] * y[1] + x[3] * y[3]) % r;
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  return out;
}

/** Table index of a matrix (as the shader computes it: no normalization). @param {number} r @param {ArrayLike<number>} m */
export const matIndex = (r, m) => ((m[0] * r + m[1]) * r + m[2]) * r + m[3];

/** Scale so the first non-zero entry is 1 (one representative per element of PGL). @param {number} r @param {Int32Array} m */
function normalize(r, m) {
  const f = m[0] || m[1] || m[2] || m[3];
  let k = 1;
  while ((f * k) % r !== 1) k++;
  for (let i = 0; i < 4; i++) m[i] = (m[i] * k) % r;
  return m;
}

/**
 * Proper k-colouring of a graph by DSATUR with backtracking, then evened out: a vertex of the
 * commonest colour moves to a rarer one its neighbours don't use. Deterministic.
 * @param {number[][]} adj @param {number} k
 */
function colourGraph(adj, k) {
  const n = adj.length;
  const col = new Int8Array(n).fill(-1);
  /** @type {number[]} */
  const stack = [];
  const pick = () => {
    let best = -1;
    let bs = -1;
    for (let i = 0; i < n; i++) {
      if (col[i] >= 0) continue;
      let mask = 0;
      for (const j of adj[i]) if (col[j] >= 0) mask |= 1 << col[j];
      let s = 0;
      for (let c = 0; c < k; c++) s += (mask >> c) & 1;
      if (s > bs) [best, bs] = [i, s];
    }
    return best;
  };
  let v = pick();
  let from = 0;
  while (v >= 0) {
    let c = from;
    while (c < k && adj[v].some((j) => col[j] === c)) c++;
    if (c < k) {
      col[v] = c;
      stack.push(v);
      v = pick();
      from = 0;
    } else {
      if (!stack.length) throw new Error("not colourable");
      v = /** @type {number} */ (stack.pop());
      from = col[v] + 1;
      col[v] = -1;
    }
  }
  const counts = new Array(k).fill(0);
  for (const c of col) counts[c]++;
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < k; c++) {
        if (counts[c] + 1 < counts[col[i]] && !adj[i].some((j) => col[j] === c)) {
          counts[col[i]]--;
          counts[c]++;
          col[i] = c;
          moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
  return col;
}

/** @typedef {ReturnType<typeof buildGroup>} DiskGroup */

/** @param {string} name */
function buildGroup(name) {
  const [p, q] = tilingPQ(name);
  const { r, A: a, B: b, C: c } = QUOTIENTS[name];
  const A = Int32Array.from(a);
  const B = Int32Array.from(b);
  const C = Int32Array.from(c);
  const key = (/** @type {ArrayLike<number>} */ m) => matIndex(r, normalize(r, Int32Array.from(m)));
  // The kites are the rotation subgroup's elements: words of even length in a, b, c. Track the
  // parity beside the matrix (it needn't be a function of the matrix in a small quotient).
  /** @type {Map<number, number>} */
  const seen = new Map();
  /** @type {[Int32Array, number][]} */
  const all = [];
  const add = (/** @type {Int32Array} */ m, /** @type {number} */ par) => {
    const k = key(m) * 2 + par;
    if (!seen.has(k)) {
      seen.set(k, all.length);
      all.push([normalize(r, Int32Array.from(m)), par]);
    }
  };
  add(new Int32Array([1, 0, 0, 1]), 0);
  for (let i = 0; i < all.length; i++) for (const g of [A, B, C]) add(matMul(r, all[i][0], g, new Int32Array(4)), 1 - all[i][1]);
  const kites = all.filter((e) => e[1] === 0).map((e) => e[0]);
  /** @type {Map<number, number>} */
  const kiteOf = new Map();
  kites.forEach((m, i) => kiteOf.set(key(m), i));
  const rho = matMul(r, B, A, new Int32Array(4));
  const tau = matMul(r, C, B, new Int32Array(4));
  const tmp = new Int32Array(4);
  /** @type {number[][]} */
  const adj = kites.map(() => []);
  kites.forEach((m, i) => {
    for (const g of [rho, tau]) {
      const j = /** @type {number} */ (kiteOf.get(key(matMul(r, m, g, tmp))));
      if (!adj[i].includes(j)) adj[i].push(j);
      if (!adj[j].includes(i)) adj[j].push(i);
    }
  });
  const col = colourGraph(adj, 3);
  /** Colour class of a kite's matrix (any scalar multiple); −1 if it isn't one. @param {ArrayLike<number>} m */
  const classOf = (m) => {
    const i = kiteOf.get(key(m));
    return i === undefined ? -1 : col[i];
  };

  const rhoPow = new Int32Array(4 * p);
  const e = new Int32Array([1, 0, 0, 1]);
  for (let k = 0; k < p; k++) {
    rhoPow.set(e, 4 * k);
    matMul(r, e, rho, e);
  }

  // Per kite f, every scalar multiple: the classes of the four kites round the edge midpoint M
  // in f's frame — f (holding T), fρ⁻¹ (across O–M), fτ (across M–V), fac (the half-turn about M).
  const table = new Uint8Array(r ** 4 * 4).fill(255);
  const rhoI = matMul(r, A, B, new Int32Array(4));
  const mu = matMul(r, A, C, new Int32Array(4));
  const s = new Int32Array(4);
  for (const f of kites) {
    const quad = [classOf(f), classOf(matMul(r, f, rhoI, tmp)), classOf(matMul(r, f, tau, tmp)), classOf(matMul(r, f, mu, tmp))];
    for (let k = 1; k < r; k++) {
      for (let i = 0; i < 4; i++) s[i] = (f[i] * k) % r;
      table.set(quad, matIndex(r, s) * 4);
    }
  }
  return { p, q, r, A, B, C, rho: rhoPow, kites, classOf, table, classes: 3 };
}

/** @type {Record<string, DiskGroup>} */
const GROUPS = {};

/** The quotient, colouring and lookup table of a Tiling option (cached). @param {unknown} name */
export function diskGroup(name) {
  const key = TILINGS.includes(String(name)) ? String(name) : TILINGS[0];
  return (GROUPS[key] ??= buildGroup(key));
}

// ---- Geometry: the edge-midpoint chart and the kites' uv ---------------------------------
//
// Every point of T lies in the "diamond" round its edge midpoint M: the four triangles T, aT,
// cT, acT, one corner of each of the four kites that meet at M. disk.frag moves M to the
// centre (φ, a translation along the real axis), takes Klein coordinates (geodesics are
// straight there, so the diamond is a rhombus with corners O, V, O′, V̄) and scales them to the
// square chart (s, t) ∈ [−1, 1]²: corners O = (−1, −1), V = (1, −1), O′ = (1, 1), V̄ = (−1, 1),
// M = (0, 0). The kites' shared edges are the diagonals (O–M–O′: s = t; V̄–M–V: s = −t); the
// warp acts in this square. A quadrant's homography takes the square to its kite's uv.

/** 3×3 row-major helpers for isometries in the Klein model (they act projectively). */
const m3 = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
  /** @type {number[]} */
  const o = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return o;
};
/** Translation along the real axis by hyperbolic distance d. @param {number} d */
const shiftX = (d) => [Math.cosh(d), 0, Math.sinh(d), 0, 1, 0, Math.sinh(d), 0, Math.cosh(d)];
/** @param {number[]} m */
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
}
/** Homography taking the unit square's corners (0,0) (1,0) (1,1) (0,1) to the points P0…P3. @param {number[][]} P */
function squareToQuad(P) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = P;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
const klein = (/** @type {number} */ x, /** @type {number} */ y) => {
  const k = 2 / (1 + x * x + y * y);
  return [x * k, y * k];
};
const poincare = (/** @type {number} */ x, /** @type {number} */ y) => {
  const k = 1 / (1 + Math.sqrt(Math.max(0, 1 - x * x - y * y)));
  return [x * k, y * k];
};
/** Apply a 3×3 projective map to a 2D point. @param {number[]} H @param {number} x @param {number} y */
const apply3 = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

/** @typedef {ReturnType<typeof buildGeometry>} DiskGeometry */

/** @param {string} name */
function buildGeometry(name) {
  const [p, q] = tilingPQ(name);
  const t = tiling(p, q);
  const m = t.cx - t.r; // edge midpoint M on the real axis
  const ca = Math.cos(t.alpha);
  const sa = Math.sin(t.alpha);
  const vr = t.cx * ca - Math.sqrt(t.cx * t.cx * ca * ca - 1); // vertex V on the ray at α
  const V = [vr * ca, vr * sa];
  // φ(V) = (V − m) / (1 − mV) lies on the imaginary axis at i·v.
  const nx = V[0] - m;
  const ny = V[1];
  const dx = 1 - m * V[0];
  const dy = -m * V[1];
  const v = (ny * dx - nx * dy) / (dx * dx + dy * dy);
  const km = (2 * m) / (1 + m * m);
  const kv = (2 * v) / (1 + v * v);
  const dM = 2 * Math.atanh(m);

  // Mirrors in the Klein model: a (real axis), b (line at α), c (circle C = φ⁻¹(imaginary axis)).
  const A = [1, 0, 0, 0, -1, 0, 0, 0, 1];
  const c2 = Math.cos(2 * t.alpha);
  const s2 = Math.sin(2 * t.alpha);
  const B = [c2, s2, 0, s2, -c2, 0, 0, 0, 1];
  const C = m3(m3(shiftX(dM), [-1, 0, 0, 0, 1, 0, 0, 0, 1]), shiftX(-dM));
  // A point p of the frame lies, per quadrant, in kite f, fρ⁻¹, fτ, fac; its coordinates in
  // that kite's own frame are p, ρp, (cb)⁻¹p = bcp, (ac)⁻¹p = cap.
  const L = [[1, 0, 0, 0, 1, 0, 0, 0, 1], m3(B, A), m3(B, C), m3(C, A)];
  // Kite uv: O, M, V, M′ (frame Klein coordinates) → (0,0), (1,0), (1,1), (0,1).
  const kM = klein(m, 0);
  const kV = klein(V[0], V[1]);
  const kM2 = [kM[0] * c2, kM[0] * s2];
  const corners = [[0, 0], kM, kV, kM2];
  const Hk = inv3(squareToQuad(corners));
  const square = [km / 2, km / 2, 0, kv / 2, -kv / 2, 0, 0, 0, 1]; // (s, t) → chart Klein
  const H = new Float32Array(36);
  const centres = new Float32Array(8);
  const centreK = apply3(inv3(Hk), 0.5, 0.5);
  /** @type {number[][]} */
  const Hq = [];
  for (let k = 0; k < 4; k++) {
    const h = m3(m3(m3(Hk, L[k]), shiftX(dM)), square);
    Hq.push(h);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[9 * k + c * 3 + r] = h[r * 3 + c];
    const ck = apply3(inv3(L[k]), centreK[0], centreK[1]);
    const cp = poincare(ck[0], ck[1]);
    centres[2 * k] = cp[0];
    centres[2 * k + 1] = cp[1];
  }
  return {
    p,
    q,
    tiling: t,
    /** Edge midpoint M (x), and the chart rhombus's half-diagonals (Klein). */
    m,
    km,
    kv,
    /** Per quadrant: square chart → kite uv (column-major mat3s, uniformMatrix3fv-ready). */
    H,
    Hq,
    /** Per quadrant: its kite's centre (uv ½, ½) in the frame (Poincaré), for the rings. */
    centres,
    /** Kite area (hyperbolic): two triangles of angle defect π/2 − π/p − π/q. */
    kiteArea: 2 * Math.PI * (0.5 - 1 / p - 1 / q),
  };
}

/** @type {Record<string, DiskGeometry>} */
const GEOMETRIES = {};

/** The chart and kite homographies of a Tiling option (cached). @param {unknown} name */
export function diskGeometry(name) {
  const key = TILINGS.includes(String(name)) ? String(name) : TILINGS[0];
  return (GEOMETRIES[key] ??= buildGeometry(key));
}

/** A tile result (createDiskTiler). */
export const createTile = () => ({ cls: -1, quad: -1, kite: -1, u: 0, v: 0, odd: 0 });

/**
 * The tiling at a disk point, step for step as disk.frag computes it (for the tests): fold
 * into T tracking the quotient matrix and parity, into the frame, the chart square, the warp,
 * the quadrant, its kite's uv and colour. `kite` identifies the kite in the quotient.
 * @param {unknown} name
 */
export function createDiskTiler(name) {
  const g = diskGroup(name);
  const geo = diskGeometry(name);
  const { r, p } = g;
  const { alpha, cx } = geo.tiling;
  const r2 = geo.tiling.r * geo.tiling.r;
  const a2 = 2 * alpha;
  const E = new Int32Array(4);
  const K = new Int32Array(4);
  const quadEl = [
    new Int32Array([1, 0, 0, 1]),
    matMul(r, g.A, g.B, new Int32Array(4)),
    matMul(r, g.C, g.B, new Int32Array(4)),
    matMul(r, g.A, g.C, new Int32Array(4)),
  ];
  const w = [0, 0];
  return {
    /**
     * @param {number} x @param {number} y disk point
     * @param {Float32Array | null} amps the warp (createDiskWarp().amps), or null for the bare kites
     * @param {ReturnType<typeof createTile>} out
     */
    tileAt(x, y, amps, out) {
      E[0] = 1;
      E[1] = 0;
      E[2] = 0;
      E[3] = 1;
      let odd = 0;
      for (let i = 0; i < FOLD_ITERATIONS; i++) {
        const k = Math.floor(Math.atan2(y, x) / a2);
        if (k !== 0) {
          const c = Math.cos(-k * a2);
          const s = Math.sin(-k * a2);
          [x, y] = [x * c - y * s, x * s + y * c];
          matMul(r, E, g.rho.subarray(4 * (((k % p) + p) % p)), E);
        }
        if (Math.atan2(y, x) > alpha) {
          const c = Math.cos(a2);
          const s = Math.sin(a2);
          [x, y] = [x * c + y * s, x * s - y * c];
          matMul(r, E, g.B, E);
          odd ^= 1;
        }
        const dx = x - cx;
        const d2 = dx * dx + y * y;
        if (d2 >= r2) break;
        x = cx + (r2 * dx) / d2;
        y = (r2 * y) / d2;
        matMul(r, E, g.C, E);
        odd ^= 1;
      }
      if (odd) {
        y = -y;
        matMul(r, E, g.A, E);
      }
      // Chart: ζ = (z − m) / (1 − m z), then Klein, then the square.
      const m = geo.m;
      const nx = x - m;
      const ny = y;
      const ddx = 1 - m * x;
      const ddy = -m * y;
      const dd = ddx * ddx + ddy * ddy;
      const zx = (nx * ddx + ny * ddy) / dd;
      const zy = (ny * ddx - nx * ddy) / dd;
      const kf = 2 / (1 + zx * zx + zy * zy);
      const kx = (zx * kf) / geo.km;
      const ky = (zy * kf) / geo.kv;
      let s = kx + ky;
      let t = kx - ky;
      if (amps) {
        diskWarp(amps, s, t, w);
        [s, t] = w;
      }
      const sx = s + t; // ∝ Klein x
      const sy = s - t; // ∝ Klein y
      const quad = sx < 0 ? (sy > 0 ? 0 : 1) : sy > 0 ? 2 : 3;
      const h = geo.Hq[quad];
      const hw = h[6] * s + h[7] * t + h[8];
      out.u = (h[0] * s + h[1] * t + h[2]) / hw;
      out.v = (h[3] * s + h[4] * t + h[5]) / hw;
      out.quad = quad;
      out.odd = odd;
      out.cls = g.table[matIndex(r, E) * 4 + quad];
      matMul(r, E, quadEl[quad], K);
      out.kite = matIndex(r, normalize(r, K));
      return out;
    },
  };
}

/** Stub. @param {Float32Array} amps @param {number} s @param {number} t @param {number[]} out */
export function diskWarp(amps, s, t, out) {
  out[0] = s;
  out[1] = t;
  return out;
}
