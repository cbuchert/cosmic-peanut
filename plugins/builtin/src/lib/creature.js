// @ts-check
/**
 * Tentacube creature dynamics (pure, allocation-free per step): seeded PRNG, damped springs for
 * the pulse / twist / twitch, the material-morph sequencer and the reduce-motion defaults.
 */

/**
 * mulberry32: a tiny seeded PRNG, so beat twists pick the same axes every run.
 * @param {number} seed
 */
export function createRng(seed) {
  let s = seed | 0;
  return {
    /** @returns {number} uniform in [0, 1) */
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * A critically-/under-damped scalar spring toward a moving target (semi-implicit Euler; step it at
 * a fixed small h).
 * @param {number} freq natural frequency (Hz)
 * @param {number} zeta damping ratio (< 1 overshoots)
 */
export function createSpring(freq, zeta) {
  const w = 2 * Math.PI * freq;
  const k = w * w;
  const c = 2 * zeta * w;
  return {
    x: 0,
    v: 0,
    /** @param {number} dv */
    impulse(dv) {
      this.v += dv;
    },
    /** @param {number} h @param {number} target */
    step(h, target) {
      this.v += (k * (target - this.x) - c * this.v) * h;
      this.x += this.v * h;
    },
  };
}

/**
 * Angle (rad) of the rotation between two unit quaternions [x, y, z, w].
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
export function quatAngle(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}

/**
 * out = a * b (Hamilton product, [x, y, z, w]); out may alias a or b.
 * @param {Float64Array} out @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
function quatMul(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * out = rotation by |r| about r/|r| (a rotation vector).
 * @param {Float64Array} out @param {number} rx @param {number} ry @param {number} rz
 */
function quatFromRotVec(out, rx, ry, rz) {
  const a = Math.hypot(rx, ry, rz);
  const s = a > 1e-12 ? Math.sin(a / 2) / a : 0.5;
  out[0] = rx * s;
  out[1] = ry * s;
  out[2] = rz * s;
  out[3] = Math.cos(a / 2);
  return out;
}

/** @param {Float64Array} q */
function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  q[0] /= n;
  q[1] /= n;
  q[2] /= n;
  q[3] /= n;
}

/**
 * Rotate the vector (x, y, z) by unit quaternion q into out[o..o+2].
 * @param {ArrayLike<number>} q @param {number} x @param {number} y @param {number} z
 * @param {Float32Array | Float64Array} out @param {number} o
 */
export function quatRotate(q, x, y, z, out, o) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + qy * tz - qz * ty;
  out[o + 1] = y + qw * ty + qz * tx - qx * tz;
  out[o + 2] = z + qw * tz + qx * ty - qy * tx;
}

const TWIST_FREQ = 1.5;
const TWIST_ZETA = 0.32;
/** The idle tumble axis (normalised below). */
const IDLE_AXIS = [0.35, 1, 0.2];
const IDLE_NORM = Math.hypot(IDLE_AXIS[0], IDLE_AXIS[1], IDLE_AXIS[2]);

/**
 * The cube's orientation: a rotational spring (angular velocity `w`, world frame) pulling `q`
 * toward `target`. A kick turns the target a quarter turn (scaled by strength) about one of the
 * cube's own face axes, picked by the seeded rng, so the cube twists, overshoots and settles; the
 * idle rate slowly tumbles the target.
 * @param {{ next(): number }} rng
 */
export function createTwist(rng) {
  const wn = 2 * Math.PI * TWIST_FREQ;
  const k = wn * wn;
  const c = 2 * TWIST_ZETA * wn;
  const tmp = new Float64Array(4);
  const err = new Float64Array(4);
  const axis = new Float64Array(3);
  return {
    q: new Float64Array([0, 0, 0, 1]),
    target: new Float64Array([0, 0, 0, 1]),
    w: new Float64Array(3),
    /** @param {number} strength 0..1 (clamped) */
    kick(strength) {
      const s = Math.min(1, Math.max(0.3, strength));
      const pick = Math.min(2, Math.floor(rng.next() * 3));
      const sign = rng.next() < 0.5 ? -1 : 1;
      // The cube's local face axis in world space.
      quatRotate(this.target, pick === 0 ? 1 : 0, pick === 1 ? 1 : 0, pick === 2 ? 1 : 0, axis, 0);
      const a = sign * s * (Math.PI / 2);
      quatFromRotVec(tmp, axis[0] * a, axis[1] * a, axis[2] * a);
      quatMul(this.target, tmp, this.target);
      quatNormalize(this.target);
    },
    /** @param {number} h fixed step (s) @param {number} idleRate rad/s */
    step(h, idleRate) {
      const q = this.q;
      const t = this.target;
      const w = this.w;
      if (idleRate !== 0) {
        const a = (idleRate * h) / IDLE_NORM;
        quatFromRotVec(tmp, IDLE_AXIS[0] * a, IDLE_AXIS[1] * a, IDLE_AXIS[2] * a);
        quatMul(t, tmp, t);
        quatNormalize(t);
      }
      // err = target * conj(q), shortest way round, as a rotation vector.
      tmp[0] = -q[0];
      tmp[1] = -q[1];
      tmp[2] = -q[2];
      tmp[3] = q[3];
      quatMul(err, t, tmp);
      if (err[3] < 0) {
        err[0] = -err[0];
        err[1] = -err[1];
        err[2] = -err[2];
        err[3] = -err[3];
      }
      const sn = Math.hypot(err[0], err[1], err[2]);
      const ang = 2 * Math.atan2(sn, err[3]);
      const f = sn > 1e-12 ? ang / sn : 2;
      for (let i = 0; i < 3; i++) w[i] += (k * err[i] * f - c * w[i]) * h;
      quatFromRotVec(tmp, w[0] * h, w[1] * h, w[2] * h);
      quatMul(q, tmp, q);
      quatNormalize(q);
    },
  };
}

const TWITCH_FREQ = 7;
const TWITCH_ZETA = 0.25;
const TWITCH_KICK_POS = 4.5;
const TWITCH_KICK_ROT = 6.5;

/**
 * Twitch: small, fast, damped jolts of position (`pos`) and rotation vector (`rot`) — a stiff,
 * lightly damped 3-D spring kicked in a random (seeded) direction.
 * @param {{ next(): number }} rng
 */
export function createTwitch(rng) {
  const wn = 2 * Math.PI * TWITCH_FREQ;
  const k = wn * wn;
  const c = 2 * TWITCH_ZETA * wn;
  const vp = new Float64Array(3);
  const vr = new Float64Array(3);
  /** Kick `v` by `mag` in a random direction. @param {Float64Array} v @param {number} mag */
  function kickRandom(v, mag) {
    const z = rng.next() * 2 - 1;
    const a = rng.next() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    v[0] += mag * r * Math.cos(a);
    v[1] += mag * r * Math.sin(a);
    v[2] += mag * z;
  }
  return {
    pos: new Float64Array(3),
    rot: new Float64Array(3),
    /** @param {number} amount ≈0..1 */
    jolt(amount) {
      kickRandom(vp, amount * TWITCH_KICK_POS);
      kickRandom(vr, amount * TWITCH_KICK_ROT);
    },
    /** @param {number} h */
    step(h) {
      const p = this.pos;
      const r = this.rot;
      for (let i = 0; i < 3; i++) {
        vp[i] += (-k * p[i] - c * vp[i]) * h;
        p[i] += vp[i] * h;
        vr[i] += (-k * r[i] - c * vr[i]) * h;
        r[i] += vr[i] * h;
      }
    },
  };
}

const TRANSIENT_TAU = 0.5;
const TRANSIENT_REFRACTORY = 0.15;
const FLUX_JUMP = 0.25;
const TREB_JUMP = 0.5;

/**
 * Detects sharp attacks: flux or treble rising well above its own recent average. Returns the
 * attack strength (0 when nothing fired), at most once per refractory gap.
 */
export function createTransient() {
  let fluxAvg = -1;
  let trebAvg = 0;
  let since = Infinity;
  return {
    /** @param {number} flux @param {number} treb @param {number} dt @returns {number} */
    step(flux, treb, dt) {
      if (fluxAvg < 0) {
        fluxAvg = flux;
        trebAvg = treb;
      }
      since += dt;
      const fj = (flux - fluxAvg) / FLUX_JUMP;
      const tj = (treb - trebAvg) / TREB_JUMP;
      const a = 1 - Math.exp(-dt / TRANSIENT_TAU);
      fluxAvg += (flux - fluxAvg) * a;
      trebAvg += (treb - trebAvg) * a;
      const j = Math.max(fj, tj);
      if (j < 1 || since < TRANSIENT_REFRACTORY) return 0;
      since = 0;
      return Math.min(1, 0.4 + 0.3 * (j - 1));
    },
  };
}
