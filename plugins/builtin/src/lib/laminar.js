// @ts-check
/**
 * Pure, allocation-free music → motion logic for Laminar (the sim math lives in flow.js, the GPU
 * side in shaders/laminar/). Everything here runs on the CPU once per frame and is unit-tested.
 */

/** The loudness reference never drops below this (dBFS), so a quiet source stays calm. */
export const REF_FLOOR_DB = -20;
/** Loudness 0 → 1 spans this many dB below the reference. */
export const SPAN_DB = 20;
const ATTACK = 0.12; // s, rms follower
const RELEASE = 0.9;
const GLIDE_UP = 0.3; // s, the 0–1 result
const GLIDE_DOWN = 1;
const REF_FALL = 0.5; // dB/s the reference sinks after a loud passage (~20 s of memory)

/**
 * How loud the music is right now relative to how loud it has recently been, 0–1: an rms
 * follower in dB against a slow peak reference (instant up, sinking 0.5 dB/s, floored at
 * REF_FLOOR_DB). So a quiet passage after a loud one reads low, loud music saturates at 1 and a
 * source that never gets loud stays calm. Exact per dt (same at 60 and 120 Hz).
 */
export function createLoudness() {
  let env = 0;
  let ref = REF_FLOOR_DB;
  return {
    value: 0,
    /** @param {{ rms: number, silent: boolean }} audio @param {number} dt seconds */
    step(audio, dt) {
      const rms = audio.silent || !Number.isFinite(audio.rms) ? 0 : audio.rms;
      env += (rms - env) * (1 - Math.exp(-dt / (rms > env ? ATTACK : RELEASE)));
      const db = 20 * Math.log10(env > 1e-6 ? env : 1e-6);
      ref -= REF_FALL * dt;
      if (db > ref) ref = db;
      if (ref < REF_FLOOR_DB) ref = REF_FLOOR_DB;
      let v = (db - (ref - SPAN_DB)) / SPAN_DB;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      // dB is steep near silence: glide the result so the flow never lurches.
      this.value += (v - this.value) * (1 - Math.exp(-dt / (v > this.value ? GLIDE_UP : GLIDE_DOWN)));
      return this.value;
    },
    reset() {
      env = 0;
      ref = REF_FLOOR_DB;
      this.value = 0;
    },
  };
}

/** Inflow speed at Flow speed 1 in silence, screen heights per second. */
export const BASE_INFLOW = 0.16;
/** Reynolds number (U·D/ν of the sphere) in silence and at full loudness, at Turbulence 1. */
export const RE_QUIET = 60;
export const RE_LOUD = 3000;
/** Turbulence (0–2) scales Re by 4^(turbulence − 1): ×¼ … ×4. */
export const RE_MIN = RE_QUIET / 4;
export const RE_MAX = RE_LOUD * 4;

/**
 * Music → flow: how turbulent the wake is allowed to get. Loudness (0–1) × Reactivity drives
 *   inflow U = BASE_INFLOW · speed · (1 + 0.7·e)
 *   Re = RE_QUIET · (RE_LOUD / RE_QUIET)^e · 4^(turbulence − 1)
 *   ν = U · D / Re   (kinematic viscosity, screen heights² / s, for the sim's viscous step)
 *   vort = turbulence · (0.1 + 0.9·e)   (vorticity confinement, 0–2)
 * with e = clamp(loudness · reactivity, 0, 1). Quiet: Re ≈ 60, a calm, gently rippling wake;
 * loud: Re in the thousands, the wake sheds and churns. Allocation-free; writes `out`.
 * @param {number} loud 0–1 (createLoudness)
 * @param {number} reactivity 0–2
 * @param {number} speed Flow speed multiplier
 * @param {number} turbulence 0–2
 * @param {number} diameter sphere diameter, screen heights
 * @param {{ inflow: number, re: number, nu: number, vort: number }} out
 */
export function flowDrive(loud, reactivity, speed, turbulence, diameter, out) {
  const x = loud * (reactivity > 0 ? reactivity : 0);
  const e = x > 0 ? (x < 1 ? x : 1) : 0;
  const t = turbulence > 0 ? (turbulence < 2 ? turbulence : 2) : 0;
  out.inflow = BASE_INFLOW * (speed > 0 ? speed : 0) * (1 + 0.7 * e);
  out.re = RE_QUIET * Math.pow(RE_LOUD / RE_QUIET, e) * Math.pow(4, t - 1);
  out.nu = (out.inflow * diameter) / out.re;
  out.vort = t * (0.1 + 0.9 * e);
  return out;
}

/** The sphere swells by at most this fraction of its radius on the bass. */
export const PULSE_MAX = 0.18;
const PULSE_ATTACK = 0.08; // s
const PULSE_RELEASE = 0.3;

/**
 * The sphere's bass pulse: `scale` (radius multiplier, 1 … 1 + PULSE_MAX) follows the smoothed
 * bass above its average (bassAtt 1 = average) × Reactivity through a one-pole with a bounded
 * attack, so a kick swells it without popping; `rate` is d scale / dt, which the sim turns into
 * the sphere surface pushing fluid out (flow.js obstacleVelocity). Exact per dt.
 */
export function createPulse() {
  return {
    scale: 1,
    rate: 0,
    /** @param {number} bassAtt @param {number} dt seconds @param {number} reactivity 0–2 */
    step(bassAtt, dt, reactivity) {
      const b = Number.isFinite(bassAtt) ? bassAtt : 1;
      let x = (b - 0.85) * (reactivity > 0 ? reactivity : 0);
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      const target = 1 + PULSE_MAX * x;
      const prev = this.scale;
      const tau = target > prev ? PULSE_ATTACK : PULSE_RELEASE;
      this.scale = prev + (target - prev) * (1 - Math.exp(-dt / tau));
      this.rate = dt > 0 ? (this.scale - prev) / dt : 0;
    },
    reset() {
      this.scale = 1;
      this.rate = 0;
    },
  };
}

/** Half-axes (along-stream, cross-stream) of the ellipse around home the sphere drifts in, screen heights. */
/** @type {[number, number]} */
export const DRIFT_REGION = [0.1, 0.18];
const DRIFT_OMEGA = 2 * Math.PI * 0.3; // spring, rad/s
const DRIFT_ZETA = 0.8; // damping ratio: one soft overshoot at most
const DRIFT_KICK = 0.3; // speed a full-strength beat adds, screen heights / s
const DRIFT_VMAX = 0.6;
const DRIFT_SUB = 1 / 240; // integration substep, s
const GOLDEN = 2.399963229728653; // golden angle, rad

/**
 * The sphere's drift through the stream: an offset (x along the flow, y across it, screen
 * heights) from its home, on a damped spring. Each beat kicks its velocity (strength × Reactivity)
 * in the next direction of a golden-angle sequence, stretched across the stream; the spring pulls
 * it back. It never leaves the DRIFT_REGION ellipse (projected back onto the rim, outward velocity
 * removed) and moves continuously — beats change its velocity, never its position — so the sim
 * sees a smooth obstacle track; (vx, vy) is its velocity for the solid boundary. Integrated in
 * fixed 1/240 s substeps (semi-implicit Euler), so 60 and 120 Hz agree.
 */
export function createDrift() {
  let dir = 0.9;
  let acc = 0;
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    /**
     * @param {boolean} onset a beat landed this frame
     * @param {number} strength its onset strength (≈0–1)
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(onset, strength, dt, reactivity) {
      if (onset) {
        const s = Number.isFinite(strength) ? (strength < 0 ? 0 : strength > 1 ? 1 : strength) : 0;
        const k = DRIFT_KICK * (0.4 + 0.6 * s) * (reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0);
        dir += GOLDEN;
        this.vx += 0.5 * k * Math.cos(dir);
        this.vy += k * Math.sin(dir);
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > DRIFT_VMAX) {
          this.vx *= DRIFT_VMAX / sp;
          this.vy *= DRIFT_VMAX / sp;
        }
      }
      acc += dt;
      while (acc >= DRIFT_SUB) {
        acc -= DRIFT_SUB;
        const w2 = DRIFT_OMEGA * DRIFT_OMEGA;
        const c = 2 * DRIFT_ZETA * DRIFT_OMEGA;
        this.vx += (-w2 * this.x - c * this.vx) * DRIFT_SUB;
        this.vy += (-w2 * this.y - c * this.vy) * DRIFT_SUB;
        this.x += this.vx * DRIFT_SUB;
        this.y += this.vy * DRIFT_SUB;
        const ex = this.x / DRIFT_REGION[0];
        const ey = this.y / DRIFT_REGION[1];
        const r2 = ex * ex + ey * ey;
        if (r2 > 1) {
          const r = Math.sqrt(r2);
          this.x /= r;
          this.y /= r;
          // Outward normal of the ellipse; drop the outward part of the velocity.
          let nx = this.x / (DRIFT_REGION[0] * DRIFT_REGION[0]);
          let ny = this.y / (DRIFT_REGION[1] * DRIFT_REGION[1]);
          const nl = Math.hypot(nx, ny);
          nx /= nl;
          ny /= nl;
          const vn = this.vx * nx + this.vy * ny;
          if (vn > 0) {
            this.vx -= vn * nx;
            this.vy -= vn * ny;
          }
        }
      }
    },
    reset() {
      this.x = this.y = this.vx = this.vy = 0;
      dir = 0.9;
      acc = 0;
    },
  };
}
