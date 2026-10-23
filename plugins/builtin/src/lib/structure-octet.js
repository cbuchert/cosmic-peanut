// @ts-check
/**
 * The octet-truss structure (shaders/lattice/structure-octet.glsl): a rounded cube at every node
 * of a face-centred cubic lattice (the integer points with an even coordinate sum, so period 2)
 * and 12 struts per node along the face diagonals, leaving through the cube's 12 edges. Every
 * planar slice is triangulated: alternating tetrahedra and octahedra, Fuller's space frame.
 *
 * The struts chain into whole straight lines: in each plane z = k they are the lines x − y ≡ k
 * and x + y ≡ k (mod 2), and likewise in the planes x = k and y = k. So the distance to the struts
 * is exact and cheap: per line family, the nearest of a checkerboard lattice of lines (two
 * roundings). The nodes are the nearest even-sum point (Conway and Sloane's D3 decoder).
 *
 * Free space: no straight line misses the struts by much, but along each face diagonal there are
 * channels (x − y = 1, z = δ and their images, δ = (√3 − 1)/2) that clear the strut axes by δ ≈
 * 0.366 and the nodes by 0.634. Three of them cross at each junction J = (1 + δ, δ, δ) + FCC, at
 * 60°, so the camera walks those in half-diagonal steps, turning only at junctions (≥ 0.31 from
 * the strut axes through the B-spline's corner).
 *
 * Pulses run on the strut graph: between nodes the hop count is the FCC gauge
 * max(|d|∞, |d|₁ / 2), exact, and a point on a strut is reached through its nearer end.
 */
import { THICKNESS, geometry as cubicGeometry } from "./lattice.js";
import { createChannelCamera, stepWalk } from "./strut-camera.js";

/** Octet struts are √2 long and twelve to a node: its rods and cubes are the cubic ones × this. */
const SCALE = 0.75;

/**
 * Strut radius, cube half-size and cube rounding (cells) for a Rod thickness, into `out`.
 * @param {number} thickness @param {Float32Array} out
 */
export function geometry(thickness, out) {
  cubicGeometry(thickness, out);
  for (let i = 0; i < 3; i++) out[i] *= SCALE;
  return out;
}

/** Strut length (cells). */
const L = Math.SQRT2;
/** Channel offset from the strut planes (cells). */
const DELTA = (Math.sqrt(3) - 1) / 2;
/** Worst-case rod radius and cube corner reach (cells), over every Rod thickness. */
const WORST = geometry(THICKNESS.max, new Float32Array(3));
const ROD = WORST[0];
const CORNER = Math.sqrt(3) * (WORST[1] - WORST[2]) + WORST[2];

/**
 * The nearest point with an even coordinate sum (an FCC node, or a diamond A site), into `out`.
 * @param {ArrayLike<number>} p @param {Float64Array} out
 */
export function fccNode(p, out) {
  for (let c = 0; c < 3; c++) out[c] = Math.floor(p[c] + 0.5);
  if ((out[0] + out[1] + out[2]) % 2 !== 0) {
    // Odd sum: move the coordinate that rounded farthest the other way.
    const fx = Math.abs(p[0] - out[0]);
    const fy = Math.abs(p[1] - out[1]);
    const fz = Math.abs(p[2] - out[2]);
    const k = fx >= fy && fx >= fz ? 0 : fy >= fz ? 1 : 2;
    out[k] += p[k] - out[k] >= 0 ? 1 : -1;
  }
  return out;
}

/** FCC hop count between nodes `d` apart (exact for nodes; a gauge in between). @param {ArrayLike<number>} d */
export function fccHops(d) {
  const x = Math.abs(d[0]);
  const y = Math.abs(d[1]);
  const z = Math.abs(d[2]);
  return Math.max(x, y, z, (x + y + z) / 2);
}

/**
 * Distance to the nearest line of one family: in the planes `a` = k (integers), the lines `s` = n
 * with n ≡ k (mod 2), where s is a diagonal coordinate (x ± y and so on, √2 per cell).
 * @param {number} a @param {number} s
 */
function family(a, s) {
  const k0 = 2 * Math.floor(a / 2 + 0.5);
  const n0 = 2 * Math.floor(s / 2 + 0.5);
  const k1 = 2 * Math.floor((a - 1) / 2 + 0.5) + 1;
  const n1 = 2 * Math.floor((s - 1) / 2 + 0.5) + 1;
  const d0 = (a - k0) ** 2 + (s - n0) ** 2 / 2;
  const d1 = (a - k1) ** 2 + (s - n1) ** 2 / 2;
  return Math.sqrt(Math.min(d0, d1));
}

const node = new Float64Array(3);

/**
 * Distance from `p` to the nearest strut axis and to the nearest node centre, into `out`.
 * @param {ArrayLike<number>} p @param {Float64Array} out
 */
export function axisDistances(p, out) {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  out[0] = Math.min(family(x, y - z), family(x, y + z), family(y, x - z), family(y, x + z), family(z, x - y), family(z, x + y));
  fccNode(p, node);
  out[1] = Math.hypot(x - node[0], y - node[1], z - node[2]);
  return out;
}

/** The node's shape at `q` from its centre: a rounded cube. @param {ArrayLike<number>} q @param {ArrayLike<number>} g */
export function nodeShape(q, g) {
  const b = g[1] - g[2];
  const qx = Math.abs(q[0]) - b;
  const qy = Math.abs(q[1]) - b;
  const qz = Math.abs(q[2]) - b;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return out + Math.min(Math.max(qx, qy, qz), 0) - g[2];
}

const ad = new Float64Array(2);
const q = new Float64Array(3);

/** The scene distance (structure-octet.glsl sceneSDF) for geometry `g`. @param {ArrayLike<number>} p @param {ArrayLike<number>} g */
export function sceneDistance(p, g) {
  axisDistances(p, ad);
  fccNode(p, node);
  for (let c = 0; c < 3; c++) q[c] = p[c] - node[c];
  return Math.min(ad[0] - g[0], nodeShape(q, g));
}

/** Free distance at `pos` from the thickest struts and largest cubes. @param {ArrayLike<number>} pos */
export function clearance(pos) {
  axisDistances(pos, ad);
  return Math.min(ad[0] - ROD, ad[1] - CORNER);
}

/** Pulse topology: a pulse starts at the nearest node. */
export const pulseSource = fccNode;

const n0 = new Float64Array(3);
const n1 = new Float64Array(3);
const e = new Float64Array(3);
const d = new Float64Array(3);

/**
 * Strut-graph distance (cells) from node `b` to `a`, a node or a point on a strut axis
 * (structure-octet.glsl pulseMetric). @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
export function pulseMetric(a, b) {
  fccNode(a, n0);
  for (let c = 0; c < 3; c++) e[c] = a[c] - n0[c];
  const s = Math.hypot(e[0], e[1], e[2]);
  for (let c = 0; c < 3; c++) d[c] = n0[c] - b[c];
  const d0 = L * fccHops(d);
  if (s < 1e-6) return d0;
  for (let c = 0; c < 3; c++) {
    n1[c] = Math.floor(n0[c] + (e[c] * L) / s + 0.5);
    d[c] = n1[c] - b[c];
  }
  return Math.min(d0 + s, L * fccHops(d) + L - s);
}

/** Half face-diagonal steps along the three channels through a junction (both ways). */
const STEPS = [
  [0.5, 0.5, 0],
  [-0.5, -0.5, 0],
  [0.5, 0, 0.5],
  [-0.5, 0, -0.5],
  [0, 0.5, 0.5],
  [0, -0.5, -0.5],
];

/** The octet camera: the channel walk from the junction (1 + δ, δ, δ). @param {number} seed */
export function octetCamera(seed) {
  return createChannelCamera(seed, stepWalk(STEPS, [1 + DELTA, DELTA, DELTA], 0, 2));
}
export const camera = octetCamera;

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function octetRuntime(ctx) {
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
