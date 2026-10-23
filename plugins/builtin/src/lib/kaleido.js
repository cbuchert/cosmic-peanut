// @ts-check
/**
 * Kaleidoscope (Lattice's "kaleidoscope" structure; shaders/lattice/structure-kaleidoscope.glsl):
 * a kaleidoscopic IFS grown in every cell of a mirror-repeated lattice, with naves carved along
 * the cell edges for the camera. The pure, tested logic: the distance estimator (mirrored by the
 * shader), the curated looks and their easing, and the nave clearance.
 *
 * The fractal (Knighty's Menger KIFS, bent): at each of up to ITERS steps, fold z into the
 * positive octant and sort its coordinates (the octahedral mirrors), rotate by R, scale by S
 * about the offset O (z = S z − O (S − 1), the third axis only past its midpoint, as in the
 * Menger IFS), and multiply the running derivative by S. The distance is the unit box's at the
 * final z over the running derivative: every step is a similarity or a mirror, so it is a
 * Lipschitz-1 bound up to the bends (rotation lets a little of the next box poke out of the
 * last: the march steps 0.8 of it).
 *
 * Space: positions in cells, nodes at multiples of PERIOD. Each coordinate is folded into
 * [0, PERIOD/2] by mirrors through the nodes and the mid-planes (an isometry wherever it's
 * smooth, so the folded estimator is still a bound), and the fractal's unit box fills a cell.
 * Naves of radius NAVE are carved along the cell edges — the lines where two coordinates sit on
 * mid-planes — which is exactly where the cubic camera (scaled by PERIOD) flies: the camera can
 * never meet the fractal, whatever its parameters.
 */

/** Cell size (cells) and the fractal's scale into it (its unit box is a cell's half-size). */
export const PERIOD = 6;
export const HALF = PERIOD / 2;
/** Radius of the naves carved along the cell edges. */
export const NAVE = 1.3;
/** Most KIFS iterations (the shader stops earlier where a step's boxes are under a pixel). */
export const ITERS = 7;

/**
 * The curated looks: rotation angles (radians about x, y, z, applied in that order), offset and
 * scale. All keep the naves' walls architectural (columns, ribs, galleries) and read at a glance;
 * the music bends angles and offsets within ±BEND around them.
 * @type {{ name: string, angles: number[], offset: number[], scale: number }[]}
 */
export const LOOKS = [
  // Columns and pierced screens down every nave.
  { name: "nave", angles: [0, 0.18, 0], offset: [1, 1, 1], scale: 3 },
  // Ribbed star vaults at the crossings.
  { name: "vault", angles: [0.2, 0, 0], offset: [1, 1, 1], scale: 3 },
  // Stacked galleries opening off the naves.
  { name: "gallery", angles: [0, 0.18, 0], offset: [1, 1, 0.7], scale: 3 },
  // Tall arcades of piers and arches.
  { name: "arcade", angles: [0, 0.18, 0], offset: [1.2, 1, 1], scale: 3.3 },
];
/** How far the music may bend the angles (radians) and offsets around a look. */
export const BEND = { angle: 0.12, offset: 0.12 };

/**
 * Rotation matrix (row-major, 9) for angles about x, then y, then z, into `out`.
 * @param {ArrayLike<number>} a @param {Float64Array | Float32Array} out
 */
export function rotation(a, out) {
  const cx = Math.cos(a[0]);
  const sx = Math.sin(a[0]);
  const cy = Math.cos(a[1]);
  const sy = Math.sin(a[1]);
  const cz = Math.cos(a[2]);
  const sz = Math.sin(a[2]);
  // R = Rz · Ry · Rx
  out[0] = cz * cy;
  out[1] = cz * sy * sx - sz * cx;
  out[2] = cz * sy * cx + sz * sx;
  out[3] = sz * cy;
  out[4] = sz * sy * sx + cz * cx;
  out[5] = sz * sy * cx - cz * sx;
  out[6] = -sy;
  out[7] = cy * sx;
  out[8] = cy * cx;
  return out;
}

/** @typedef {{ rot: ArrayLike<number>, offset: ArrayLike<number>, scale: number }} Kifs */

/** A coordinate folded into [0, HALF] by mirrors through the nodes and the mid-planes. */
function fold(/** @type {number} */ x) {
  const m = x + HALF;
  return Math.abs(m - PERIOD * Math.floor(m / PERIOD) - HALF);
}

/**
 * The fractal's distance bound at a cell point, before the naves.
 * @param {number} px @param {number} py @param {number} pz @param {Kifs} k @param {number} iters
 */
function kifs(px, py, pz, k, iters) {
  // The fractal is centred on the cell edges, so its central tunnels are the naves.
  let x = (HALF - fold(px)) / HALF;
  let y = (HALF - fold(py)) / HALF;
  let z = (HALF - fold(pz)) / HALF;
  const r = k.rot;
  const s = k.scale;
  const ox = k.offset[0] * (s - 1);
  const oy = k.offset[1] * (s - 1);
  const oz = k.offset[2] * (s - 1);
  let dr = 1;
  for (let i = 0; i < iters; i++) {
    x = Math.abs(x);
    y = Math.abs(y);
    z = Math.abs(z);
    let t;
    if (x < y) (t = x), (x = y), (y = t);
    if (x < z) (t = x), (x = z), (z = t);
    if (y < z) (t = y), (y = z), (z = t);
    const rx = r[0] * x + r[1] * y + r[2] * z;
    const ry = r[3] * x + r[4] * y + r[5] * z;
    const rz = r[6] * x + r[7] * y + r[8] * z;
    x = s * rx - ox;
    y = s * ry - oy;
    z = s * rz;
    if (z > 0.5 * oz) z -= oz;
    dr *= s;
  }
  const bx = Math.abs(x) - 1;
  const by = Math.abs(y) - 1;
  const bz = Math.abs(z) - 1;
  const box = Math.hypot(Math.max(bx, 0), Math.max(by, 0), Math.max(bz, 0)) + Math.min(Math.max(bx, by, bz), 0);
  return (box / dr) * HALF;
}

/**
 * Distance from a point to the nearest nave axis (the cell edges: two coordinates on mid-planes).
 * @param {ArrayLike<number>} p
 */
export function naveDistance(p) {
  const ax = HALF - fold(p[0]);
  const ay = HALF - fold(p[1]);
  const az = HALF - fold(p[2]);
  return Math.min(Math.hypot(ax, ay), Math.hypot(ay, az), Math.hypot(ax, az));
}

/**
 * The scene's distance bound (cells): the fractal with the naves carved out. Mirrors sceneSDF.
 * @param {ArrayLike<number>} p @param {Kifs} k @param {number} [iters]
 */
export function kaleidoDE(p, k, iters = ITERS) {
  return Math.max(kifs(p[0], p[1], p[2], k, iters), NAVE - naveDistance(p));
}

/**
 * Free distance at a camera position against any parameters: the fractal may fill everything
 * outside the naves, so it is the distance to the nave walls.
 * @param {ArrayLike<number>} pos
 */
export function kaleidoClearance(pos) {
  return NAVE - naveDistance(pos);
}

/** Seconds each look holds, then the crossfade to the next. */
export const HOLD = 45;
export const FADE = 12;
/** The bends' easing: two first-order stages of this time constant (s). */
const BEND_TAU = 1.2;
/** The bands' slow average (s) the bends are measured against, and its floor. */
const AVG_TAU = 4;
const FLOOR = 0.02;
/** Under Reduce motion the bends are this much smaller. */
const REDUCED_BEND = 0.4;

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The fold parameters over time: the curated looks in turn (HOLD s each, FADE s crossfades,
 * eased), bent by the music — the angles by the mids, the offsets by the treble, each measured
 * against its own slow average (so a lift bends and a steady level settles back) and eased
 * through two slow stages. Nothing pumps on the beat here: beats ripple locally in the shader.
 * Nothing is allocated per step.
 */
export function createKaleidoMusic() {
  const avg = new Float64Array(2);
  const mid = new Float64Array(2);
  const bend = new Float64Array(2); // mids → angles, treble → offsets; −1…1
  let clock = 0;
  const m = {
    /** The look being held or faded from (index into LOOKS). */
    look: 0,
    angles: new Float64Array(3),
    offset: new Float64Array(3),
    scale: LOOKS[0].scale,
    /** The fold rotation for `angles` (row-major). */
    rot: new Float64Array(9),
    /**
     * @param {Float32Array} bands `audio.bands` @param {number} dt @param {number} react 0–2
     * @param {boolean} reduceMotion @param {boolean} [live] false in silence: the bends settle
     */
    step(bands, dt, react, reduceMotion, live = true) {
      clock += dt;
      const n = bands.length;
      const ka = 1 - Math.exp(-dt / AVG_TAU);
      const k = 1 - Math.exp(-dt / BEND_TAU);
      for (let b = 0; b < 2; b++) {
        // Mids: bands 16–40 of 64; treble: 40–64.
        const lo = Math.floor(((b === 0 ? 16 : 40) * n) / 64);
        const hi = Math.max(lo + 1, Math.floor(((b === 0 ? 40 : 64) * n) / 64));
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        e /= hi - lo;
        avg[b] += (e - avg[b]) * ka;
        const ratio = Math.min(2, e / (avg[b] + FLOOR));
        const r = Math.max(0, Math.min(2, react)) * (reduceMotion ? REDUCED_BEND : 1);
        const target = live ? Math.max(-1, Math.min(1, r * (ratio - 1))) : 0;
        mid[b] += (target - mid[b]) * k;
        bend[b] += (mid[b] - bend[b]) * k;
      }
      const cycle = HOLD + FADE;
      const t = clock % (cycle * LOOKS.length);
      m.look = Math.floor(t / cycle);
      const w = smooth((t - m.look * cycle - HOLD) / FADE);
      const a = LOOKS[m.look];
      const b = LOOKS[(m.look + 1) % LOOKS.length];
      for (let i = 0; i < 3; i++) {
        m.angles[i] = a.angles[i] + (b.angles[i] - a.angles[i]) * w + bend[0] * BEND.angle;
        m.offset[i] = a.offset[i] + (b.offset[i] - a.offset[i]) * w + bend[1] * BEND.offset;
      }
      m.scale = a.scale + (b.scale - a.scale) * w;
      rotation(m.angles, m.rot);
      return m;
    },
  };
  m.angles.set(LOOKS[0].angles);
  m.offset.set(LOOKS[0].offset);
  rotation(m.angles, m.rot);
  return m;
}
