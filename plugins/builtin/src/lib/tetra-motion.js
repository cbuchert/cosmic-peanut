// @ts-check
/** Tetraballs motion: pure, allocation-free logic driven by the waveform. */

/**
 * Split the waveform into four consecutive quarters (one per ball) and write each quarter's RMS
 * and absolute peak. Works for any length ≥ 4 (a remainder goes to the last quarter).
 * @param {Float32Array} wave
 * @param {Float32Array} rms length ≥ 4
 * @param {Float32Array} peak length ≥ 4
 */
export function quarterStats(wave, rms, peak) {
  const n = wave.length;
  const q = n >> 2;
  for (let b = 0; b < 4; b++) {
    const start = b * q;
    const end = b === 3 ? n : start + q;
    let s = 0;
    let p = 0;
    for (let i = start; i < end; i++) {
      const v = wave[i];
      s += v * v;
      const a = v < 0 ? -v : v;
      if (a > p) p = a;
    }
    const len = end - start;
    rms[b] = len > 0 ? Math.sqrt(s / len) : 0;
    peak[b] = p;
  }
}

/**
 * One-pole envelope follower with separate attack and release time constants (seconds),
 * frame-rate independent, output clamped to 0..max (non-finite input counts as 0 / max).
 * @param {number} attack
 * @param {number} release
 * @param {number} [max=1]
 */
export function createFollower(attack, release, max = 1) {
  let v = 0;
  return {
    get value() {
      return v;
    },
    /** @param {number} x @param {number} dt */
    step(x, dt) {
      const t = x > max ? max : x > 0 ? x : 0; // NaN → 0
      const tau = t > v ? attack : release;
      v += (t - v) * (1 - Math.exp(-dt / tau));
      return v;
    },
    reset() {
      v = 0;
    },
  };
}

/** Integration substep (s): frame-rate independent for any dt that is a multiple of it. */
const SUB = 1 / 480;

/**
 * Damped spring (mass 1) pulling an offset toward a target. Underdamped, so a kick rises,
 * overshoots back through rest and settles. The offset is clamped to ±max (velocity is zeroed
 * against the wall), so no input can throw it out of bounds.
 * @param {number} freq natural frequency, Hz
 * @param {number} zeta damping ratio (< 1 overshoots)
 * @param {number} max bound on |offset|
 */
export function createSpring(freq, zeta, max) {
  const w = 2 * Math.PI * freq;
  const k = w * w;
  const c = 2 * zeta * w;
  const vmax = max * w * 4;
  let x = 0;
  let v = 0;
  return {
    get value() {
      return x;
    },
    get velocity() {
      return v;
    },
    /** Add velocity (units of offset per second). @param {number} dv */
    kick(dv) {
      v += dv;
      if (v > vmax) v = vmax;
      else if (v < -vmax) v = -vmax;
      else if (!(v === v)) v = 0;
    },
    /** @param {number} target @param {number} dt */
    step(target, dt) {
      const t = target > max ? max : target < -max ? -max : target === target ? target : 0;
      const n = Math.max(1, Math.ceil(dt / SUB - 1e-9));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        v += (k * (t - x) - c * v) * h; // semi-implicit Euler
        x += v * h;
        if (x > max) {
          x = max;
          if (v > 0) v = 0;
        } else if (x < -max) {
          x = -max;
          if (v < 0) v = 0;
        }
      }
      return x;
    },
    reset() {
      x = 0;
      v = 0;
    },
  };
}

/**
 * The four vertices of a regular tetrahedron with unit circumradius, centred on the origin
 * (alternate corners of a cube), as x, y, z triples.
 * @param {Float32Array} out length ≥ 12
 */
export function tetraVertices(out) {
  const s = 1 / Math.sqrt(3);
  const c = [1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1];
  for (let i = 0; i < 12; i++) out[i] = c[i] * s;
  return out;
}

/** Extra spin (rad/s of spring velocity) per unit beat strength. */
const SPIN_KICK = 6;

/**
 * Slow tumble of the tetrahedron: a unit quaternion (x, y, z, w) turned at `speed` rad/s about an
 * axis that wanders smoothly. A beat adds a spring-damped (critically damped) burst of extra spin
 * that rises and settles back to the base rate.
 */
export function createTumble() {
  const q = new Float64Array([0, 0, 0, 1]);
  const spin = createSpring(1.2, 1, 2);
  let clock = 0;
  let rate = 0;
  return {
    q,
    get rate() {
      return rate;
    },
    /**
     * @param {number} dt
     * @param {number} speed base rate, rad/s
     * @param {boolean} beat an onset landed this frame
     * @param {number} strength 0–1 onset strength
     * @returns {number} current rate, rad/s
     */
    step(dt, speed, beat, strength) {
      if (beat) spin.kick(SPIN_KICK * Math.min(1, Math.max(0, strength)));
      spin.step(0, dt);
      rate = speed + (speed === 0 ? 0 : Math.sign(speed)) * Math.max(0, spin.value);
      clock += dt;
      let ax = Math.sin(0.23 * clock);
      let ay = 0.8 + 0.3 * Math.cos(0.19 * clock);
      let az = Math.cos(0.31 * clock);
      const inv = 1 / Math.hypot(ax, ay, az);
      ax *= inv;
      ay *= inv;
      az *= inv;
      const h = 0.5 * rate * dt;
      const s = Math.sin(h);
      const dx = ax * s;
      const dy = ay * s;
      const dz = az * s;
      const dw = Math.cos(h);
      // q = d * q
      const x = q[0];
      const y = q[1];
      const z = q[2];
      const w = q[3];
      const nx = dw * x + dx * w + dy * z - dz * y;
      const ny = dw * y - dx * z + dy * w + dz * x;
      const nz = dw * z + dx * y - dy * x + dz * w;
      const nw = dw * w - dx * x - dy * y - dz * z;
      const n = 1 / Math.hypot(nx, ny, nz, nw);
      q[0] = nx * n;
      q[1] = ny * n;
      q[2] = nz * n;
      q[3] = nw * n;
      return rate;
    },
    /** Column-major 3x3 rotation matrix (GLSL mat3). @param {Float32Array} out length ≥ 9 */
    matrix(out) {
      const x = q[0];
      const y = q[1];
      const z = q[2];
      const w = q[3];
      out[0] = 1 - 2 * (y * y + z * z);
      out[1] = 2 * (x * y + z * w);
      out[2] = 2 * (x * z - y * w);
      out[3] = 2 * (x * y - z * w);
      out[4] = 1 - 2 * (x * x + z * z);
      out[5] = 2 * (y * z + x * w);
      out[6] = 2 * (x * z + y * w);
      out[7] = 2 * (y * z - x * w);
      out[8] = 1 - 2 * (x * x + y * y);
      return out;
    },
  };
}

/** Ball-centre distance from the centroid at rest (fused: the edge is under bridgeDistance). */
export const REST_DIST = 0.45;
/** Largest outward (and inward) spring offset. */
export const OFF_MAX = 1;
export const MAX_DIST = REST_DIST + OFF_MAX;
export const MIN_DIST = 0.2;
/** Ball radius range (before the Size param scales the whole scene). */
export const R_MIN = 0.3;
export const R_MAX = 0.52;
/** Auto-gain floors (waveform units), so silence doesn't get amplified into motion. */
const RMS_FLOOR = 0.04;
/** Spring pull per unit transient at bounce 1, and the velocity kick an onset adds. */
const PULL = 0.45;
const KICK = 3.2;

/**
 * Per-ball size and bounce from the waveform's four quarters.
 * Size: each quarter's RMS, auto-gained against a slow reference (the loudest quarter over the last
 * few seconds), through an attack/release follower → radius in R_MIN..R_MAX.
 * Bounce: each quarter's peak above its own recent average is a transient; it pulls that ball's
 * underdamped spring outward (and an onset kicks it), so hits burst the shape apart and the
 * springs pull it back together with a little rebound.
 */
export function createBalls() {
  const radius = new Float32Array(4).fill(R_MIN);
  const dist = new Float32Array(4).fill(REST_DIST);
  const rms = new Float32Array(4);
  const peak = new Float32Array(4);
  const trans = new Float32Array(4);
  const level = [0, 1, 2, 3].map(() => createFollower(0.04, 0.25));
  const slowPeak = [0, 1, 2, 3].map(() => createFollower(0.15, 0.6));
  const hold = [0, 1, 2, 3].map(() => createFollower(0.005, 0.12));
  const spring = [0, 1, 2, 3].map(() => createSpring(2.2, 0.35, OFF_MAX));
  const ref = createFollower(0.3, 5, Infinity);

  return {
    radius,
    dist,
    /**
     * @param {Float32Array} wave newest waveform
     * @param {number} dt
     * @param {number} reactivity 0–2: how much the audio moves sizes and bounces
     * @param {number} bounce 0–2: bounce amount
     * @param {boolean} onset
     * @param {number} onsetStrength 0–1
     */
    step(wave, dt, reactivity, bounce, onset, onsetStrength) {
      quarterStats(wave, rms, peak);
      let loud = 0;
      for (let b = 0; b < 4; b++) if (rms[b] > loud) loud = rms[b];
      const r = Math.max(RMS_FLOOR, ref.step(loud, dt));
      const pr = r * Math.SQRT2; // peak of a sine at the reference RMS
      const kick = onset ? KICK * bounce * Math.min(1, Math.max(0, onsetStrength)) : 0;
      for (let b = 0; b < 4; b++) {
        const lv = level[b].step((0.8 * reactivity * rms[b]) / r, dt);
        radius[b] = R_MIN + (R_MAX - R_MIN) * lv;
        const avg = slowPeak[b].step(peak[b], dt);
        trans[b] = hold[b].step((reactivity * (peak[b] - avg)) / pr, dt);
        if (kick > 0) spring[b].kick(kick * trans[b]);
        const off = spring[b].step(PULL * bounce * trans[b], dt);
        dist[b] = Math.max(MIN_DIST, Math.min(MAX_DIST, REST_DIST + off));
      }
    },
  };
}

/** Manifest defaults for Tumble speed (rad/s) and Bounce, and their Reduce-motion stand-ins. */
export const DEFAULT_TUMBLE = 0.35;
export const DEFAULT_BOUNCE = 1;
const REDUCED_TUMBLE = 0.12;
const REDUCED_BOUNCE = 0.45;

/**
 * Reduce motion calms the tumble and the bounce while they're at their defaults; a value the user
 * chose explicitly is kept.
 * @param {number} tumble
 * @param {number} bounce
 * @param {boolean} reduceMotion
 * @param {{ tumble: number, bounce: number }} out
 */
export function effectiveMotion(tumble, bounce, reduceMotion, out) {
  out.tumble = reduceMotion && tumble === DEFAULT_TUMBLE ? REDUCED_TUMBLE : tumble;
  out.bounce = reduceMotion && bounce === DEFAULT_BOUNCE ? REDUCED_BOUNCE : bounce;
  return out;
}
