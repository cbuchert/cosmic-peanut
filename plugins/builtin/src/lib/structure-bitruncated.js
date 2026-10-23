// @ts-check
/**
 * The bitruncated cubic honeycomb (shaders/lattice/structure-bitruncated.glsl): space filled with
 * truncated octahedra, drawn as their edges (struts) with small balls at the vertices — a foam of
 * square and hexagonal windows. The cells sit on a body-centred cubic lattice (the integer points
 * whose coordinates are all even or all odd; period 2), each the Voronoi cell of its centre: square
 * faces at distance 1 along the axes, hexagons at √3/2 along the body diagonals, edges √2/2, four
 * edges and four cells at every vertex (the vertices and edges form the sodalite net).
 *
 * Distance: inside its own cell a point folds by the cube's mirrors (|x|, |y|, |z|, sorted) into
 * one chamber, where only two edges and one vertex remain — a square edge and a hexagon edge from
 * (1, ½, 0). That is exact (checked against brute force in strut-structures.test.js).
 *
 * Free space: the camera flies from cell centre to cell centre straight through the windows,
 * along the axes (square windows, 0.35 from the edges) or the body diagonals (hexagons, 0.61), and
 * turns only at centres, onto any of those directions up to 90° off.
 *
 * Pulses run along the edges: a point on an edge is reached through its nearer end. The sodalite
 * net's hop count has no closed form, so a vertex's is estimated from its distance r to the source,
 * max(r, √2 r − 0.29) cells (exact one hop out; within about a hop and a half by 4 hops).
 */
import { THICKNESS } from "./lattice.js";
import { createChannelCamera, stepWalk } from "./strut-camera.js";

/** Edge length (cells). */
const L = Math.SQRT2 / 2;

/**
 * Edge radius and vertex-ball radius (cells) for a Rod thickness, into `out` (the third is unused).
 * @param {number} thickness @param {Float32Array} out
 */
export function geometry(thickness, out) {
  const t = Math.max(THICKNESS.min, Math.min(THICKNESS.max, Number(thickness) || THICKNESS.default));
  out[0] = 0.6 * t;
  out[1] = 1.02 * t + 0.01;
  out[2] = 0;
  return out;
}

const WORST = geometry(THICKNESS.max, new Float32Array(3));

/** The fold: cell centre, folded offset (sorted |·|, largest first), and which axis each came from. */
const centre = new Float64Array(3);
const fq = new Float64Array(3);
const axis = new Int32Array(3);
const sgn = new Float64Array(3);

/** Fold `p` into its cell's chamber (into centre / fq / axis / sgn). @param {ArrayLike<number>} p */
function fold(p) {
  let d0 = 0;
  let d1 = 0;
  for (let c = 0; c < 3; c++) {
    const e = 2 * Math.floor(p[c] / 2 + 0.5);
    const o = 2 * Math.floor((p[c] - 1) / 2 + 0.5) + 1;
    d0 += (p[c] - e) ** 2;
    d1 += (p[c] - o) ** 2;
    centre[c] = e;
    fq[c] = o; // borrowed for the odd centre
  }
  if (d1 < d0) centre.set(fq);
  for (let c = 0; c < 3; c++) {
    const r = p[c] - centre[c];
    sgn[c] = r < 0 ? -1 : 1;
    fq[c] = Math.abs(r);
    axis[c] = c;
  }
  // Sort descending, carrying the axes.
  for (const [i, j] of [
    [0, 1],
    [1, 2],
    [0, 1],
  ]) {
    if (fq[j] > fq[i]) {
      const t = fq[i];
      fq[i] = fq[j];
      fq[j] = t;
      const k = axis[i];
      axis[i] = axis[j];
      axis[j] = k;
    }
  }
}

/** Distance from the folded point to segment (ax, ay, az)–(bx, by, bz). */
function seg(/** @type {number} */ ax, /** @type {number} */ ay, /** @type {number} */ az, /** @type {number} */ bx, /** @type {number} */ by, /** @type {number} */ bz) {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const px = fq[0] - ax;
  const py = fq[1] - ay;
  const pz = fq[2] - az;
  const t = Math.max(0, Math.min(1, (px * ux + py * uy + pz * uz) / (ux * ux + uy * uy + uz * uz)));
  return Math.hypot(px - t * ux, py - t * uy, pz - t * uz);
}

/**
 * Distance from `p` to the nearest edge axis and to the nearest vertex, into `out`.
 * @param {ArrayLike<number>} p @param {Float64Array} out
 */
export function axisDistances(p, out) {
  fold(p);
  out[0] = Math.min(seg(1, 0.5, 0, 1, 0, 0.5), seg(1, 0.5, 0, 0.5, 1, 0));
  out[1] = Math.hypot(fq[0] - 1, fq[1] - 0.5, fq[2]);
  return out;
}

/** A vertex ball's shape at `q` from its centre. @param {ArrayLike<number>} q @param {ArrayLike<number>} g */
export function nodeShape(q, g) {
  return Math.hypot(q[0], q[1], q[2]) - g[1];
}

const ad = new Float64Array(2);

/** The scene distance (structure-bitruncated.glsl sceneSDF). @param {ArrayLike<number>} p @param {ArrayLike<number>} g */
export function sceneDistance(p, g) {
  axisDistances(p, ad);
  return Math.min(ad[0] - g[0], ad[1] - g[1]);
}

/** Free distance at `pos` from the thickest edges and largest balls. @param {ArrayLike<number>} pos */
export function clearance(pos) {
  axisDistances(pos, ad);
  return Math.min(ad[0] - WORST[0], ad[1] - WORST[1]);
}

/** Pulse topology: a pulse starts at the nearest vertex. @param {ArrayLike<number>} p @param {Float64Array} out */
export function pulseSource(p, out) {
  fold(p);
  // The chamber's vertex (1, ½, 0), unfolded.
  out[axis[0]] = centre[axis[0]] + sgn[axis[0]];
  out[axis[1]] = centre[axis[1]] + 0.5 * sgn[axis[1]];
  out[axis[2]] = centre[axis[2]];
  return out;
}

/** Estimated hops (as cells) to a vertex `r` cells from the source. @param {number} r */
const estimate = (r) => Math.max(r, Math.SQRT2 * r - 0.29);

const n0 = new Float64Array(3);

/**
 * Distance along the edges (cells, estimated at the vertices) from vertex `b` to `a`, a vertex or
 * a point on an edge axis (structure-bitruncated.glsl pulseMetric).
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
export function pulseMetric(a, b) {
  pulseSource(a, n0);
  const ex = a[0] - n0[0];
  const ey = a[1] - n0[1];
  const ez = a[2] - n0[2];
  const s = Math.hypot(ex, ey, ez);
  const d0 = estimate(Math.hypot(n0[0] - b[0], n0[1] - b[1], n0[2] - b[2]));
  if (s < 1e-6) return d0;
  const k = L / s;
  const x = Math.round(2 * (n0[0] + ex * k)) / 2;
  const y = Math.round(2 * (n0[1] + ey * k)) / 2;
  const z = Math.round(2 * (n0[2] + ez * k)) / 2;
  return Math.min(d0 + s, estimate(Math.hypot(x - b[0], y - b[1], z - b[2])) + L - s);
}

/** Centre → window → centre steps: the six axes (square windows) and eight body diagonals (hexagons). */
const STEPS = [
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];
for (let s = 0; s < 8; s++) STEPS.push([s & 1 ? -0.5 : 0.5, s & 2 ? -0.5 : 0.5, s & 4 ? -0.5 : 0.5]);

/** @param {number} seed */
export function bitruncatedCamera(seed) {
  return createChannelCamera(seed, stepWalk(STEPS, [0, 0, 0], 0, 2));
}
export const camera = bitruncatedCamera;

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function bitruncatedRuntime(ctx) {
  const geo = new Float32Array(3);
  geometry(Number(ctx.params.thickness), geo);
  return {
    onBeat() {},
    step() {},
    upload(gl, u) {
      gl.uniform3f(u.u_geo, geo[0], geo[1], geo[2]);
    },
    params(changed) {
      if ("thickness" in changed) geometry(Number(ctx.params.thickness), geo);
    },
  };
}
