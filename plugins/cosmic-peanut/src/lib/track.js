// @ts-check
/**
 * Möbius's tracks: the closed centre lines the snake rides, sampled evenly in arc length into a
 * table the vertex shader reads (`uTrack`, RGBA32F, TRACK_SAMPLES × 3: centre, unit tangent, and
 * the cross-section direction w with the track's twist in it). Built once per Track change; the
 * camera fit and depth fade read the same table, so the JS and the shader can't disagree.
 *
 * The frame is analytic: n = normalize(up × t) is horizontal and never flips because neither
 * track's tangent is ever vertical; b = t × n; w = cos τ·n + sin τ·b with the twist τ(q) for
 * q = s / length:
 * - `loop`: today's unit circle, two laps (4π), τ = u/2 = 2πq: a cross-section comes back
 *   flipped after one lap and lined up after two.
 * - `figure-8`: an "unfolded Klein bottle", a Möbius strip and its mirror image joined. The
 *   centre line c(φ) = (a cos φ, h sin φ, a sin φ cos φ) is a lemniscate whose lobes tilt out of
 *   plane like a saddle, so its two passes through the crossing are 2h apart. Starting at the
 *   crossing, τ = π(1 − cos 2πq)/2 turns the strip half a turn one way over lobe A (right-handed)
 *   and back over lobe B (left-handed), with the twist rate easing to 0 at both crossings, where
 *   the cross-section lies flat.
 */

/** Track select options, in shader order. */
export const TRACKS = ["figure-8", "loop"];
/** Samples per table row. */
export const TRACK_SAMPLES = 1024;

/** Figure-8 lobe size and saddle height. */
const F8_A = 1.9;
const F8_H = 0.55;

/** @param {unknown} name the Track param → index into {@link TRACKS} (figure-8 if unknown) */
export function trackIndex(name) {
  return Math.max(0, TRACKS.indexOf(String(name)));
}

/**
 * Centre and derivative at curve parameter p (0–2π once round the track), into c and d.
 * @param {string} name @param {number} p @param {number[]} c @param {number[]} d
 */
function curve(name, p, c, d) {
  if (name === "loop") {
    const u = 2 * p; // two laps
    c[0] = Math.cos(u);
    c[1] = 0;
    c[2] = Math.sin(u);
    d[0] = -2 * Math.sin(u);
    d[1] = 0;
    d[2] = 2 * Math.cos(u);
    return;
  }
  const f = Math.PI / 2 + p; // start at the crossing
  const cf = Math.cos(f);
  const sf = Math.sin(f);
  c[0] = F8_A * cf;
  c[1] = F8_H * sf;
  c[2] = F8_A * sf * cf;
  d[0] = -F8_A * sf;
  d[1] = F8_H * cf;
  d[2] = F8_A * Math.cos(2 * f);
}

/** @param {string} name @param {number} q fraction of the track */
function twist(name, q) {
  return name === "loop" ? 2 * Math.PI * q : (Math.PI * (1 - Math.cos(2 * Math.PI * q))) / 2;
}

/**
 * Build a track's table. Allocates; call on Track change only.
 * @param {string} name one of {@link TRACKS}
 */
export function buildTrack(name) {
  const K = TRACK_SAMPLES;
  const D = 32 * K; // dense samples for the arc-length table
  const cum = new Float64Array(D + 1);
  const c = [0, 0, 0];
  const d = [0, 0, 0];
  const prev = [0, 0, 0];
  curve(name, 0, prev, d);
  for (let i = 1; i <= D; i++) {
    curve(name, (2 * Math.PI * i) / D, c, d);
    cum[i] = cum[i - 1] + Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]);
    prev[0] = c[0];
    prev[1] = c[1];
    prev[2] = c[2];
  }
  const length = cum[D];
  const data = new Float32Array(K * 3 * 4);
  let i = 0;
  for (let k = 0; k < K; k++) {
    const s = (length * k) / K;
    while (cum[i + 1] < s) i++;
    const p = ((2 * Math.PI) / D) * (i + (s - cum[i]) / (cum[i + 1] - cum[i]));
    curve(name, p, c, d);
    const dl = Math.hypot(d[0], d[1], d[2]);
    const t = [d[0] / dl, d[1] / dl, d[2] / dl];
    const nl = Math.hypot(t[2], t[0]);
    const n = [t[2] / nl, 0, -t[0] / nl]; // up × t
    const b = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    const tau = twist(name, k / K);
    const ct = Math.cos(tau);
    const st = Math.sin(tau);
    for (let a = 0; a < 3; a++) {
      data[k * 4 + a] = c[a];
      data[(K + k) * 4 + a] = t[a];
      data[(2 * K + k) * 4 + a] = ct * n[a] + st * b[a];
    }
  }

  /** @param {number} W @param {(x: number, y: number, z: number) => number} f */
  const edgeMax = (W, f) => {
    let m = 0;
    for (let k = 0; k < K; k++) {
      for (const v of [-W, W]) {
        const x = data[k * 4] + v * data[(2 * K + k) * 4];
        const y = data[k * 4 + 1] + v * data[(2 * K + k) * 4 + 1];
        const z = data[k * 4 + 2] + v * data[(2 * K + k) * 4 + 2];
        m = Math.max(m, f(x, y, z));
      }
    }
    return m;
  };
  return {
    name,
    /** RGBA rows: centre, tangent, cross-section direction (w = 0). */
    data,
    /** Arc length once round. */
    length,
    /** Farthest horizontal distance from the axis of the strip's edges at half width W. */
    reach: (/** @type {number} */ W) => edgeMax(W, (x, _y, z) => Math.hypot(x, z)),
    /** Highest |y| of the strip's edges at half width W. */
    height: (/** @type {number} */ W) => edgeMax(W, (_x, y) => Math.abs(y)),
  };
}
