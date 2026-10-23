// @ts-check
/**
 * Triply periodic minimal surfaces for the Lattice family (shaders/lattice/structure-tpms.glsl):
 * the gyroid, Schwarz P and Schwarz D. Each is a thickened sheet |f(k p) − c| ≤ t around the
 * level set of its trigonometric function f, period `period` cells (k = 2π / period). The sheet
 * splits space into two interlocking labyrinths; the camera flies through the one where f > c + t
 * (its skeleton: the srs net for the gyroid, the cubic net for P, the diamond net for D, whose
 * nodes are f's maxima, listed in `nodes`).
 *
 * f is not a distance. Its gradient is at most `lip` (per radian of k p) everywhere and its
 * Hessian's spectral norm at most `hess`, both checked numerically against the real derivatives
 * in tpms.test.js. So (|f − c| − t) / (k lip) is a true lower bound on the distance to the sheet:
 * the shader returns (|f − c| − t) / (k surfGrad), close to the real distance near the walls
 * (surfGrad is a typical |∇f| on the surface), and its structStep scales that by surfGrad / lip.
 *
 * The music bends the sheet (createMorph): bass slowly thickens it (up to SWELL_MAX), the mids
 * shift its level c within ±`offset` (one labyrinth's tunnels widen as the other's narrow). Both
 * are eased and clamped, and `tpmsClearance` holds against the worst case of both and of the
 * Rod thickness param (which sets the wall thickness).
 *
 * Nothing here allocates per call except the factories.
 */
import { THICKNESS } from "./lattice.js";

const TAU = 2 * Math.PI;

/**
 * @typedef {object} Surface
 * @property {number} period cells per period
 * @property {number} fmax f's maximum (at the camera labyrinth's net nodes)
 * @property {number} surfGrad a typical |∇f| on the surface (sceneSDF's scale)
 * @property {number} lip a bound on |∇f| everywhere
 * @property {number} hess a bound on the Hessian's spectral norm everywhere
 * @property {number} offset the most the mids shift the level, in f's units
 * @property {number} sub control points per net edge for the camera path
 * @property {number[][]} nodes the camera labyrinth's net nodes in one period, in eighths of it
 * @property {(x: number, y: number, z: number) => number} f the level function at k p (radians)
 * @property {(x: number, y: number, z: number, out: Float64Array) => number} grad
 *   writes ∇f (per radian) into `out` and returns f
 */

/** @type {Record<"gyroid" | "schwarz-p" | "schwarz-d", Surface>} */
export const TPMS = {
  // sin x cos y + sin y cos z + sin z cos x; its labyrinths are srs nets (three edges per node at
  // 120°, coiling into helices), here the one through f's maxima at (1, 1, 1)/8 and its images.
  gyroid: {
    period: 5,
    fmax: 1.5,
    surfGrad: 1.55,
    lip: 1.75,
    hess: 2,
    offset: 0.2,
    sub: 1,
    nodes: [
      [1, 1, 1],
      [1, 7, 3],
      [3, 1, 7],
      [3, 7, 5],
      [5, 3, 7],
      [5, 5, 5],
      [7, 3, 1],
      [7, 5, 3],
    ],
    f(x, y, z) {
      return Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x);
    },
    grad(x, y, z, out) {
      const sx = Math.sin(x);
      const sy = Math.sin(y);
      const sz = Math.sin(z);
      const cx = Math.cos(x);
      const cy = Math.cos(y);
      const cz = Math.cos(z);
      out[0] = cx * cy - sz * sx;
      out[1] = cy * cz - sx * sy;
      out[2] = cz * cx - sy * sz;
      return sx * cy + sy * cz + sz * cx;
    },
  },
  // cos x + cos y + cos z; each labyrinth is a cubic net of round chambers joined by necks.
  "schwarz-p": {
    period: 4,
    fmax: 3,
    surfGrad: 1.35,
    lip: 1.75,
    hess: 1,
    offset: 0.25,
    sub: 3,
    nodes: [[0, 0, 0]],
    f(x, y, z) {
      return Math.cos(x) + Math.cos(y) + Math.cos(z);
    },
    grad(x, y, z, out) {
      out[0] = -Math.sin(x);
      out[1] = -Math.sin(y);
      out[2] = -Math.sin(z);
      return Math.cos(x) + Math.cos(y) + Math.cos(z);
    },
  },
  // sin x sin y sin z + sin x cos y cos z + cos x sin y cos z + cos x cos y sin z; each labyrinth
  // is a diamond net (four edges per node, tetrahedral).
  "schwarz-d": {
    period: 5,
    fmax: Math.SQRT2,
    surfGrad: 1.55,
    lip: 1.75,
    hess: 2,
    offset: 0.18,
    sub: 2,
    nodes: [
      [1, 1, 1],
      [1, 5, 5],
      [3, 3, 3],
      [3, 7, 7],
      [5, 1, 5],
      [5, 5, 1],
      [7, 3, 7],
      [7, 7, 3],
    ],
    f(x, y, z) {
      const sx = Math.sin(x);
      const sy = Math.sin(y);
      const sz = Math.sin(z);
      const cx = Math.cos(x);
      const cy = Math.cos(y);
      const cz = Math.cos(z);
      return sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
    },
    grad(x, y, z, out) {
      const sx = Math.sin(x);
      const sy = Math.sin(y);
      const sz = Math.sin(z);
      const cx = Math.cos(x);
      const cy = Math.cos(y);
      const cz = Math.cos(z);
      out[0] = cx * sy * sz + cx * cy * cz - sx * sy * cz - sx * cy * sz;
      out[1] = sx * cy * sz - sx * sy * cz + cx * cy * cz - cx * sy * sz;
      out[2] = sx * sy * cz - sx * cy * sz - cx * sy * sz + cx * cy * cz;
      return sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
    },
  },
};

/** Half-thickness of the walls (cells, near them) per unit of the Rod thickness param. */
export const THICK = 1.5;
/** The most bass thickens the walls (a fraction of their thickness). */
export const SWELL_MAX = 0.4;

const clamp = (/** @type {number} */ x, /** @type {number} */ lo, /** @type {number} */ hi) =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * The sheet's uniforms into `out`: k (radians per cell), the level offset c, the half-thickness t
 * (f's units) and 1 / (k surfGrad), sceneSDF's scale to cells.
 * @param {Surface} s @param {number} thickness the Rod thickness param
 * @param {number} swell 0–SWELL_MAX @param {number} offset −1–1, × s.offset
 * @param {Float32Array | Float64Array} out
 */
export function sheet(s, thickness, swell, offset, out) {
  const k = TAU / s.period;
  const th = clamp(Number(thickness) || THICKNESS.default, THICKNESS.min, THICKNESS.max);
  out[0] = k;
  out[1] = s.offset * clamp(offset, -1, 1);
  out[2] = THICK * th * k * s.surfGrad * (1 + clamp(swell, 0, SWELL_MAX));
  out[3] = 1 / (k * s.surfGrad);
  return out;
}

/**
 * Free distance (cells) at a camera position from the worst-case sheet (thickest walls, the
 * level shifted all the way into the camera's labyrinth): the larger of two true lower bounds,
 * first order (the global gradient bound) and second order (this point's gradient and the
 * Hessian bound, which is tight in the necks where ∇f vanishes). Negative on the far side of the
 * camera labyrinth's walls.
 * @param {Surface} s
 */
export function tpmsClearance(s) {
  const k = TAU / s.period;
  const w = sheet(s, THICKNESS.max, SWELL_MAX, 1, new Float64Array(4));
  const reach = w[1] + w[2];
  const g = new Float64Array(3);
  const a = k * k * s.hess;
  return (/** @type {ArrayLike<number>} */ pos) => {
    const m = s.grad(k * pos[0], k * pos[1], k * pos[2], g) - reach;
    const first = m / (k * s.lip);
    if (m <= 0) return first;
    // f(p + v) ≥ f(p) − k |∇f| r − ½ k² hess r² for |v| = r: the smallest r that reaches the sheet.
    const b = k * Math.hypot(g[0], g[1], g[2]);
    return Math.max(first, (Math.sqrt(b * b + 2 * a * m) - b) / a);
  };
}

/**
 * The pulse topology: a pulse launched at `point` (on the camera path) starts on the nearest
 * wall: the closest mid-sheet (f = 0) hit of rays cast from the point in 26 directions (safe
 * steps of |f| / (k lip)), refined onto the sheet by a few Newton steps. Its front then spreads
 * over the walls as a ring.
 * @param {Surface} s
 */
export function wallPoint(s) {
  const k = TAU / s.period;
  const g = new Float64Array(3);
  /** @type {number[][]} */
  const dirs = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        const l = Math.hypot(x, y, z);
        if (l > 0) dirs.push([x / l, y / l, z / l]);
      }
  const eps = 1e-3;
  return (/** @type {ArrayLike<number>} */ point, /** @type {Float64Array} */ out) => {
    let best = Infinity;
    let bd = 0;
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      let t = 0;
      for (let it = 0; it < 64 && t < best; it++) {
        const v = Math.abs(s.f(k * (point[0] + d[0] * t), k * (point[1] + d[1] * t), k * (point[2] + d[2] * t)));
        if (v < eps) {
          best = t;
          bd = i;
          break;
        }
        t += v / (k * s.lip);
      }
    }
    if (best === Infinity) best = 0;
    const d = dirs[bd];
    let x = point[0] + d[0] * best;
    let y = point[1] + d[1] * best;
    let z = point[2] + d[2] * best;
    for (let i = 0; i < 4; i++) {
      const f = s.grad(k * x, k * y, k * z, g);
      const g2 = Math.max(1e-12, g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
      x -= (f * g[0]) / (k * g2);
      y -= (f * g[1]) / (k * g2);
      z -= (f * g[2]) / (k * g2);
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
  };
}

/** Easing time constants (s) of the two stages: bass, mids. */
const BASS_TAU = 0.5;
const MIDS_TAU = 0.8;
/** Longest easing substep (s). */
const H = 1 / 240;
/** Under Reduce motion the sheet bends this much. */
const REDUCED = 0.3;

/**
 * The music's bend: bass (bassAtt) slowly thickens the walls, the mids (midAtt against their
 * average of 1) shift the level either way. Each goes through two exponential stages in short
 * substeps (no snap, frame-rate independent) and is clamped to the worst case the clearance
 * assumes. Silence, or Reactivity 0, settles it back to the bare surface.
 */
export function createMorph() {
  let bass1 = 0;
  let bass2 = 0;
  let mids1 = 0;
  let mids2 = 0;
  const m = {
    /** Wall thickening, 0–SWELL_MAX. */
    swell: 0,
    /** Level shift, −1–1 (× the surface's offset). */
    offset: 0,
    /**
     * @param {{ bassAtt: number, midAtt: number }} audio @param {number} dt
     * @param {number} reactivity 0–2 @param {boolean} live @param {boolean} reduceMotion
     */
    step(audio, dt, reactivity, live, reduceMotion) {
      const react = clamp(reactivity, 0, 2);
      const scale = reduceMotion ? REDUCED : 1;
      const bass = live ? scale * clamp((audio.bassAtt - 0.5) * 0.8 * react, 0, 1) : 0;
      const mids = live ? scale * clamp((audio.midAtt - 1) * react, -1, 1) : 0;
      const n = Math.max(1, Math.ceil(dt / H - 1e-9));
      const h = dt / n;
      const kb = 1 - Math.exp(-h / BASS_TAU);
      const km = 1 - Math.exp(-h / MIDS_TAU);
      for (let i = 0; i < n; i++) {
        bass1 += (bass - bass1) * kb;
        bass2 += (bass1 - bass2) * kb;
        mids1 += (mids - mids1) * km;
        mids2 += (mids1 - mids2) * km;
      }
      m.swell = SWELL_MAX * clamp(bass2, 0, 1);
      m.offset = clamp(mids2, -1, 1);
      return m;
    },
  };
  return m;
}
