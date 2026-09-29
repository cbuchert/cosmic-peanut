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
