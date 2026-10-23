// @ts-check
/**
 * The cube-sphere behind Tiled Sphere: each of the cube's six faces is projected onto the sphere
 * (equal-angle, so a face's cells span equal angles and stretch at most ~1.4× at the corners)
 * and carries N × N lattice cells of the p4 tiling, plane coordinates [0, N]².
 *
 * Across a shared edge the two faces' planes differ by a quarter turn and a translation by whole
 * faces, a symmetry of the p4 warp (90° turns about lattice points, integer translations), so the
 * warped tiles carry on across every edge with no gap or kink. The colours need more care: a
 * quarter turn swaps the checkerboard's two classes, and every corner turns an odd number of
 * quarters (it has 3 faces, not 4), so no two-colouring closes up. The fix (mirrored in
 * shaders/tess/sphere.frag): every tile belongs to the face whose warped square holds its
 * centre and takes that face's class (seen from a neighbour, it is carried over); per-face flips
 * leave four "seam" edges, one at each corner, where tiles on both sides would match, and there
 * every other tile along the seam takes a third palette colour. Neighbours then always differ,
 * except right at the 8 corners (the acceptable distortion where three faces meet).
 *
 * This module is used at runtime for the shader's tables (sphereTables) and holds the JS mirror
 * of the shader's chart and tile colouring that the tests check.
 */
import { BLEND_PERIOD } from "./tess-music.js";

const QUARTER = Math.PI / 4;

/**
 * Faces in the order +X, −X, +Y, −Y, +Z, −Z (index = axis × 2 + negative), each with its normal
 * n and right-handed tangents u × v = n: a face's plane coordinates are (along u, along v).
 */
export const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
];

/**
 * Lattice cells per face nearest `target` that divide or are a multiple of BLEND_PERIOD (ties go
 * to the smaller), so the warp's whole period fits a face or a whole number of faces.
 * @param {number} target
 */
export function faceCells(target) {
  let best = 1;
  for (let n = 1; n <= Math.max(BLEND_PERIOD, 2 * target); n++) {
    if (BLEND_PERIOD % n !== 0 && n % BLEND_PERIOD !== 0) continue;
    if (Math.abs(n - target) < Math.abs(best - target)) best = n;
  }
  return best;
}

/** Which face a direction lies on (largest |component|). @param {number} x @param {number} y @param {number} z */
export function faceOf(x, y, z) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

/** @param {number[]} a @param {number} x @param {number} y @param {number} z */
const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;

/**
 * Plane point of a direction (any length, in front of the face) in face f's chart. Beyond the
 * face's edges this is the chart extended, which is what a pixel's warped point may reach.
 * @param {number} f @param {number} x @param {number} y @param {number} z @param {number} n cells per face
 * @param {number[]} out receives px, py
 */
export function toFace(f, x, y, z, n, out) {
  const F = FACES[f];
  const w = dot(F.n, x, y, z);
  out[0] = (n / 2) * (1 + Math.atan(dot(F.u, x, y, z) / w) / QUARTER);
  out[1] = (n / 2) * (1 + Math.atan(dot(F.v, x, y, z) / w) / QUARTER);
  return out;
}

/**
 * Unit direction of plane point (px, py) in face f's chart.
 * @param {number} f @param {number} px @param {number} py @param {number} n @param {number[]} out
 */
export function fromFace(f, px, py, n, out) {
  const F = FACES[f];
  const tu = Math.tan(QUARTER * ((2 * px) / n - 1));
  const tv = Math.tan(QUARTER * ((2 * py) / n - 1));
  let l = 0;
  for (let i = 0; i < 3; i++) {
    out[i] = F.n[i] + tu * F.u[i] + tv * F.v[i];
    l += out[i] * out[i];
  }
  l = Math.sqrt(l);
  for (let i = 0; i < 3; i++) out[i] /= l;
  return out;
}

/**
 * dp/dh of face f's chart at h (rows px then py, 3 each): the shader multiplies it by the screen
 * derivatives of the hit point, which are smooth across faces, so S never breaks at an edge.
 * @param {number} f @param {number} x @param {number} y @param {number} z @param {number} n
 * @param {Float64Array | number[]} out length 6
 */
export function faceJacobian(f, x, y, z, n, out) {
  const F = FACES[f];
  const w = dot(F.n, x, y, z);
  const s = (2 * n) / Math.PI;
  for (let r = 0; r < 2; r++) {
    const t = r === 0 ? F.u : F.v;
    const st = dot(t, x, y, z);
    const k = s / (w * w + st * st);
    for (let i = 0; i < 3; i++) out[r * 3 + i] = k * (w * t[i] - st * F.n[i]);
  }
  return out;
}

/** (x, y) turned k quarter turns anticlockwise. @param {number} x @param {number} y @param {number} k @param {number[]} out */
export function turn(x, y, k, out) {
  const q = ((k % 4) + 4) % 4;
  out[0] = q === 0 ? x : q === 1 ? -y : q === 2 ? -x : y;
  out[1] = q === 0 ? y : q === 1 ? x : q === 2 ? -y : -x;
  return out;
}

/**
 * @typedef {object} Transition crossing side s of face f (0: px = N, 1: px = 0, 2: py = N, 3: py = 0)
 * @property {number} g the face across
 * @property {number} k quarter turns, and @property {number} tx @property {number} ty the
 *   translation: p_g = turn(p_f, k) + t, exact along the shared edge
 */

/** Edge point `along` (0–n) of side s, in face coordinates. @param {number} s @param {number} along @param {number} n */
const sidePoint = (s, along, n) => (s === 0 ? [n, along] : s === 1 ? [0, along] : s === 2 ? [along, n] : [along, 0]);
/** Outward step per side, in faces. */
const OUTWARD = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The 24 face crossings, (face, side) order. @param {number} n @returns {Transition[]} */
export function transitions(n) {
  /** @type {Transition[]} */
  const out = [];
  const d = [0, 0, 0];
  const q1 = [0, 0];
  const q2 = [0, 0];
  const r = [0, 0];
  for (let f = 0; f < 6; f++) {
    for (let s = 0; s < 4; s++) {
      // The face across: just beyond the side's midpoint.
      const m = sidePoint(s, n / 2, n);
      fromFace(f, m[0] + 0.01 * n * OUTWARD[s][0], m[1] + 0.01 * n * OUTWARD[s][1], n, d);
      const g = faceOf(d[0], d[1], d[2]);
      const p1 = sidePoint(s, n / 4, n);
      const p2 = sidePoint(s, (3 * n) / 4, n);
      fromFace(f, p1[0], p1[1], n, d);
      toFace(g, d[0], d[1], d[2], n, q1);
      fromFace(f, p2[0], p2[1], n, d);
      toFace(g, d[0], d[1], d[2], n, q2);
      const turnBy = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]) - Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
      const k = ((Math.round(turnBy / (Math.PI / 2)) % 4) + 4) % 4;
      turn(p1[0], p1[1], k, r);
      out.push({ g, k, tx: Math.round((q1[0] - r[0]) / n) * n, ty: Math.round((q1[1] - r[1]) / n) * n });
    }
  }
  return out;
}

/** The p4 checkerboard class of half-unit cell (i, j) (tess.glsl tessTile). @param {number} i @param {number} j */
export const cellClass = (i, j) => (((i + j) % 2) + 2) % 2;

/**
 * Uniform-ready tables for shaders/tess/sphere.frag:
 * `frames` 6 mat3 (columns n, u, v); `nb` per (face, side): face across, quarter turns, seam (1
 * where the classes would match across the edge), low side (1 on the lower-numbered face);
 * `nbT` the crossing's translation; `flip` per face, chosen so only four edges are seams.
 * @param {number} n cells per face
 */
export function sphereTables(n) {
  const T = transitions(n);
  const frames = new Float32Array(6 * 9);
  FACES.forEach((F, f) => frames.set([...F.n, ...F.u, ...F.v], f * 9));
  // Fewest seams: a seam is an edge where flip_f ⊕ flip_g ⊕ (odd turn) = 1. Every corner keeps
  // an odd number whatever the flips, so four (one per corner) is the least; search all 64.
  let best = 0;
  let bestCount = Infinity;
  for (let mask = 0; mask < 64; mask++) {
    let count = 0;
    for (let i = 0; i < 24; i++) count += ((mask >> Math.floor(i / 4)) & 1) ^ ((mask >> T[i].g) & 1) ^ (T[i].k & 1);
    if (count < bestCount) [best, bestCount] = [mask, count];
  }
  const flip = new Int32Array(6);
  for (let f = 0; f < 6; f++) flip[f] = (best >> f) & 1;
  const nb = new Int32Array(24 * 4);
  const nbT = new Float32Array(24 * 2);
  T.forEach((t, i) => {
    const f = Math.floor(i / 4);
    nb.set([t.g, t.k, flip[f] ^ flip[t.g] ^ (t.k & 1), f < t.g ? 1 : 0], i * 4);
    nbT.set([t.tx, t.ty], i * 2);
  });
  return { frames, nb, nbT, flip };
}

/**
 * A tile's colour class 0–2 (mirrors sphere.frag sphClass): half-unit cell (i, j) of face f's
 * chart, possibly just beyond the face, with its checkerboard class `cls` in that chart.
 * @param {ReturnType<typeof sphereTables>} tab @param {number} n
 * @param {number} f @param {number} i @param {number} j @param {number} cls
 */
export function tileColor(tab, n, f, i, j, cls) {
  let cx = (i + 0.5) / 2;
  let cy = (j + 0.5) / 2;
  // The owner: the face whose square holds the centre (the furthest-out side, near a corner).
  let s = -1;
  let e = 0;
  if (cx - n > e) [s, e] = [0, cx - n];
  if (-cx > e) [s, e] = [1, -cx];
  if (cy - n > e) [s, e] = [2, cy - n];
  if (-cy > e) [s, e] = [3, -cy];
  let g = f;
  let c = cls;
  if (s >= 0) {
    const k = f * 4 + s;
    const r = turn(cx, cy, tab.nb[k * 4 + 1], [0, 0]);
    cx = r[0] + tab.nbT[k * 2];
    cy = r[1] + tab.nbT[k * 2 + 1];
    c ^= tab.nb[k * 4 + 1] & 1;
    g = tab.nb[k * 4];
  }
  const col = c ^ tab.flip[g];
  const ci = Math.floor(2 * cx);
  const cj = Math.floor(2 * cy);
  const last = 2 * n - 1;
  for (let side = 0; side < 4; side++) {
    const k = g * 4 + side;
    if (!tab.nb[k * 4 + 2]) continue;
    const touches = side === 0 ? ci === last : side === 1 ? ci === 0 : side === 2 ? cj === last : cj === 0;
    if (touches && col === (tab.nb[k * 4 + 3] ? 0 : 1)) return 2;
  }
  return col;
}
