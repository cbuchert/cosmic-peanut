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
