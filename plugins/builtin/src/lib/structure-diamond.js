// @ts-check
/**
 * The diamond structure (shaders/lattice/structure-diamond.glsl): carbon's crystal as a
 * ball-and-stick model. Atoms on two face-centred cubic lattices, A (the integer points with an
 * even coordinate sum; period 2) and B = A + (½, ½, ½), each bonded to its four nearest
 * neighbours of the other kind along the tetrahedral directions v₁…v₄ (bond √3/2, 109.47° apart).
 *
 * Distance: the bonds of the nearest A atom and of the nearest B atom (eight segments) and those
 * two atoms. That is exact (checked against brute force in strut-structures.test.js).
 *
 * Free space is the other diamond network, its sites at the odd-sum points X and X + (½, ½, ½).
 * Every midpoint of its bonds is a junction of three straight channels along face diagonals, which
 * clear the bonds by 0.61 cells. So the camera walks the dual network's bonds by their midpoints:
 * each step (half a face diagonal) shares a bond with the last, going straight on or turning 60°
 * into one of the two other channels there.
 *
 * Pulses run on the bond graph. From an A atom, d = Σ mⱼ vⱼ with Σ mⱼ = 0 (A) or 1 (B) has the
 * unique solution mⱼ = d·vⱼ + Σm / 4, and the hop count is Σ|mⱼ|; letting Σm grow from 0 to 1 along
 * a bond keeps it exact for points on bonds too.
 */
import { THICKNESS } from "./lattice.js";
import { fccNode } from "./structure-octet.js";
import { createChannelCamera } from "./strut-camera.js";

/** Bond length (cells). */
const L = Math.sqrt(3) / 2;
/** The bond vectors from an A atom (a B atom's bonds are their negatives). */
const V = [
  [0.5, 0.5, 0.5],
  [0.5, -0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
];

/**
 * Bond radius and atom radius (cells) for a Rod thickness, into `out` (the third is unused).
 * @param {number} thickness @param {Float32Array} out
 */
export function geometry(thickness, out) {
  const t = Math.max(THICKNESS.min, Math.min(THICKNESS.max, Number(thickness) || THICKNESS.default));
  out[0] = 0.8 * t;
  out[1] = 1.76 * t + 0.02;
  out[2] = 0;
  return out;
}

const WORST = geometry(THICKNESS.max, new Float32Array(3));

const a = new Float64Array(3);
const b = new Float64Array(3);
const t3 = new Float64Array(3);

/** Distance from p to the segment from `o` along `s·v`. */
function bond(/** @type {ArrayLike<number>} */ p, /** @type {Float64Array} */ o, /** @type {number[]} */ v, /** @type {number} */ s) {
  const px = p[0] - o[0];
  const py = p[1] - o[1];
  const pz = p[2] - o[2];
  const t = Math.max(0, Math.min(1, (s * (px * v[0] + py * v[1] + pz * v[2])) / 0.75));
  return Math.hypot(px - s * t * v[0], py - s * t * v[1], pz - s * t * v[2]);
}

/** The nearest A and B atoms, into `a` and `b`. @param {ArrayLike<number>} p */
function atoms(p) {
  fccNode(p, a);
  for (let c = 0; c < 3; c++) t3[c] = p[c] - 0.5;
  fccNode(t3, b);
  for (let c = 0; c < 3; c++) b[c] += 0.5;
}

/**
 * Distance from `p` to the nearest bond axis and to the nearest atom centre, into `out`.
 * @param {ArrayLike<number>} p @param {Float64Array} out
 */
export function axisDistances(p, out) {
  atoms(p);
  let s = Infinity;
  for (const v of V) s = Math.min(s, bond(p, a, v, 1), bond(p, b, v, -1));
  out[0] = s;
  out[1] = Math.min(Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]), Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]));
  return out;
}

/** An atom's shape at `q` from its centre. @param {ArrayLike<number>} q @param {ArrayLike<number>} g */
export function nodeShape(q, g) {
  return Math.hypot(q[0], q[1], q[2]) - g[1];
}

const ad = new Float64Array(2);

/** The scene distance (structure-diamond.glsl sceneSDF). @param {ArrayLike<number>} p @param {ArrayLike<number>} g */
export function sceneDistance(p, g) {
  axisDistances(p, ad);
  return Math.min(ad[0] - g[0], ad[1] - g[1]);
}

/** Free distance at `pos` from the thickest bonds and largest atoms. @param {ArrayLike<number>} pos */
export function clearance(pos) {
  axisDistances(pos, ad);
  return Math.min(ad[0] - WORST[0], ad[1] - WORST[1]);
}

/** Pulse topology: a pulse starts at the nearest A atom (the metric counts hops from one). */
export const pulseSource = fccNode;

/**
 * Bond-graph distance (cells) from A atom `bb` to `p`, an atom or a point on a bond axis
 * (structure-diamond.glsl pulseMetric). @param {ArrayLike<number>} p @param {ArrayLike<number>} bb
 */
export function pulseMetric(p, bb) {
  fccNode(p, a);
  const sigma = Math.min(1, Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) / L);
  const dx = p[0] - bb[0];
  const dy = p[1] - bb[1];
  const dz = p[2] - bb[2];
  let h = 0;
  for (const v of V) h += Math.abs(dx * v[0] + dy * v[1] + dz * v[2] + sigma / 4);
  return h * L;
}

/**
 * The midpoint walk on the dual network's bonds (all its points are junctions).
 * @returns {import('./strut-camera.js').ChannelWalk}
 */
export function diamondWalk() {
  const at = new Float64Array(3);
  // The last bond: V[j] × s (s = +1 leaving an X site, −1 leaving a Y site); the one before: V[i].
  let j = 0;
  let i = 3;
  let s = 1;
  return {
    start(out) {
      // The bond from X = (1, 0, 0) along V[0], reached from a Y site along −V[3].
      at[0] = 1.25;
      at[1] = 0.25;
      at[2] = 0.25;
      j = 0;
      i = 3;
      s = 1;
      out.set(at);
    },
    next(turn, rand, out) {
      let l = i;
      if (turn) {
        // One of the two bonds that are neither straight on (V[i]) nor back (V[j]).
        const k = Math.floor(rand() * 2);
        let n = 0;
        for (let m = 0; m < 4; m++) {
          if (m === i || m === j) continue;
          if (n++ === k) l = m;
        }
      }
      for (let c = 0; c < 3; c++) at[c] += (s * (V[j][c] - V[l][c])) / 2;
      i = j;
      j = l;
      s = -s;
      out.set(at);
      return turn ? 1 : 0;
    },
  };
}

/** @param {number} seed */
export function diamondCamera(seed) {
  return createChannelCamera(seed, diamondWalk());
}
export const camera = diamondCamera;

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function diamondRuntime(ctx) {
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
