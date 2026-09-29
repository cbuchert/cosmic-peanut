// @ts-check
/**
 * Pure, allocation-free music → motion logic for Laminar (the sim math lives in flow.js, the GPU
 * side in shaders/laminar/). Everything here runs on the CPU once per frame and is unit-tested.
 */
import { createFlashLimiter } from "./flash.js";

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
 *   inflow U = BASE_INFLOW · speed · (1 + 0.7·e²)
 *   Re = RE_QUIET · (RE_LOUD / RE_QUIET)^(e²) · 4^(turbulence − 1)
 *   ν = U · D / Re   (kinematic viscosity, screen heights² / s, for the sim's viscous step)
 *   vort = turbulence · (0.1 + 0.9·e²)   (vorticity confinement, 0–2)
 * with e = clamp(loudness · reactivity, 0, 1); squared so moderate levels stay calm and the churn
 * arrives with real loudness. Quiet: Re ≈ 60, a calm, gently rippling wake;
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
  out.inflow = BASE_INFLOW * (speed > 0 ? speed : 0) * (1 + 0.7 * e * e);
  out.re = RE_QUIET * Math.pow(RE_LOUD / RE_QUIET, e * e) * Math.pow(4, t - 1);
  out.nu = (out.inflow * diameter) / out.re;
  out.vort = t * (0.1 + 0.9 * e * e);
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
const DRIFT_OMEGA = 2 * Math.PI * 0.5; // follow spring, rad/s (critically damped)
const DRIFT_STEP = 0.12; // how far a full-strength beat moves the anchor, screen heights
const DRIFT_RETURN = 2.5; // s, the anchor's pull back home
/** The sphere never moves faster than this (screen heights / s): a sudden lurch would shake the whole stream. */
export const DRIFT_VMAX = 0.1;
const DRIFT_SUB = 1 / 240; // integration substep, s
const TURN = 0.55; // rad/s the push direction turns: a run of beats carries the sphere along a slow curve

/**
 * The sphere's drift through the stream: an offset (x along the flow, y across it, screen
 * heights) from its home. Each beat moves an invisible anchor (strength × Reactivity, in a direction
 * that slowly turns, stretched across the stream, so a run of beats carries it along a curve); the anchor relaxes back
 * home over ~2.5 s and the sphere follows it on a critically damped spring, speed-limited to
 * DRIFT_VMAX. Beats change where it's heading, never its position or velocity at once, so the sim
 * sees a smooth obstacle track; (vx, vy) is its velocity for the solid boundary. It never leaves
 * the DRIFT_REGION ellipse. Integrated in fixed 1/240 s substeps, so 60 and 120 Hz agree.
 */
export function createDrift() {
  let dir = 0.9;
  let acc = 0;
  let ax = 0;
  let ay = 0;
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
        const k = DRIFT_STEP * (0.4 + 0.6 * s) * (reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0);
        ax += 0.5 * k * Math.cos(dir);
        ay += k * Math.sin(dir);
        // Keep the anchor inside the region.
        const e = Math.hypot(ax / DRIFT_REGION[0], ay / DRIFT_REGION[1]);
        if (e > 0.9) {
          ax *= 0.9 / e;
          ay *= 0.9 / e;
        }
      }
      dir += TURN * dt;
      acc += dt;
      const w2 = DRIFT_OMEGA * DRIFT_OMEGA;
      const c = 2 * DRIFT_OMEGA;
      const back = Math.exp(-DRIFT_SUB / DRIFT_RETURN);
      while (acc >= DRIFT_SUB) {
        acc -= DRIFT_SUB;
        ax *= back;
        ay *= back;
        this.vx += (w2 * (ax - this.x) - c * this.vx) * DRIFT_SUB;
        this.vy += (w2 * (ay - this.y) - c * this.vy) * DRIFT_SUB;
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > DRIFT_VMAX) {
          this.vx *= DRIFT_VMAX / sp;
          this.vy *= DRIFT_VMAX / sp;
        }
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
      ax = ay = 0;
      dir = 0.9;
      acc = 0;
    },
  };
}

/** Beats closer than this (s) to the previous kick are ignored: the wake gets time to answer. */
export const KICK_GAP = 0.15;
/** A kick's impulse is spread over this long (s), so it lands the same at any step rate. */
export const KICK_DURATION = 0.1;

/**
 * Beat → vortex kicks for the wake. `trigger` (once per frame) arms a kick on an onset:
 * amplitude clamp((0.4 + 0.6·strength) · Reactivity, 0, 1), on the opposite side from the last
 * one, so successive beats rock the wake back and forth and seed the shedding. `step(dt)` (once
 * per sim step) returns the signed share of the kick delivered in that step — the total over a
 * kick is its amplitude, spread evenly over KICK_DURATION — which the sim multiplies into a
 * vortex pair just behind the sphere. Beats within KICK_GAP of the previous kick are skipped.
 */
export function createKicks() {
  let left = 0; // signed impulse still to deliver
  let rate = 0; // per second
  let since = Infinity;
  let side = 1;
  return {
    /** @param {boolean} onset @param {number} strength ≈0–1 @param {number} reactivity 0–2 */
    trigger(onset, strength, reactivity) {
      if (!onset || since < KICK_GAP) return;
      const st = Number.isFinite(strength) ? (strength < 0 ? 0 : strength > 1 ? 1 : strength) : 0;
      let a = (0.4 + 0.6 * st) * (reactivity > 0 ? reactivity : 0);
      a = a > 1 ? 1 : a;
      if (a <= 0) return;
      side = -side;
      left = side * a;
      rate = a / KICK_DURATION;
      since = 0;
    },
    /** @param {number} dt sim seconds @returns {number} signed impulse share for this step */
    step(dt) {
      since += dt;
      if (left === 0) return 0;
      const d = rate * dt;
      if (d >= Math.abs(left)) {
        const all = left;
        left = 0;
        return all;
      }
      const out = left > 0 ? d : -d;
      left -= out;
      return out;
    },
    reset() {
      left = 0;
      since = Infinity;
      side = 1;
    },
  };
}

export const PALETTES = ["currents", "sea glass", "sunset", "mono"];

/** @param {number[]} a */
const rgb = (a) => new Float32Array(a);
/**
 * Per palette: the lines' base colour, highlight (ridge top, specular) and shadow (ridge flank),
 * the gap colour between lines (over the "black" backdrop), and the trail's ramp from hot (just
 * past the sphere) through warm to old.
 */
const TABLE = {
  currents: {
    line: rgb([0.74, 0.6, 0.95]), hi: rgb([0.98, 0.93, 1]), shadow: rgb([0.2, 0.07, 0.36]), gap: rgb([0, 0, 0.012]),
    hot: rgb([1, 0.1, 0.3]), warm: rgb([1, 0.4, 0.12]), old: rgb([1, 0.72, 0.2]),
  },
  "sea glass": {
    line: rgb([0.55, 0.88, 0.8]), hi: rgb([0.92, 1, 0.97]), shadow: rgb([0.04, 0.22, 0.28]), gap: rgb([0, 0.015, 0.025]),
    hot: rgb([1, 0.3, 0.38]), warm: rgb([1, 0.55, 0.42]), old: rgb([1, 0.84, 0.62]),
  },
  sunset: {
    line: rgb([1, 0.62, 0.48]), hi: rgb([1, 0.94, 0.82]), shadow: rgb([0.34, 0.07, 0.24]), gap: rgb([0.015, 0, 0.03]),
    hot: rgb([0.95, 0.08, 0.4]), warm: rgb([1, 0.42, 0.1]), old: rgb([1, 0.82, 0.3]),
  },
  mono: {
    line: rgb([0.76, 0.76, 0.79]), hi: rgb([1, 1, 1]), shadow: rgb([0.1, 0.1, 0.12]), gap: rgb([0, 0, 0]),
    hot: rgb([1, 1, 1]), warm: rgb([0.85, 0.85, 0.88]), old: rgb([0.6, 0.6, 0.64]),
  },
};

/** @typedef {typeof TABLE.currents} Palette */

/** A palette by name; unknown names get "currents". @param {string} name @returns {Palette} */
export function palette(name) {
  return /** @type {Record<string, Palette>} */ (TABLE)[name] ?? TABLE.currents;
}

/** Trail age (s since the dye passed the sphere) at which it reaches its "old" colour. */
export const TRAIL_OLD = 6;

/**
 * The trail's colour at `age` seconds past the sphere: hot → warm over the first half of
 * TRAIL_OLD, warm → old over the second, then held. Mirrors trailRamp() in composite.frag.
 * @param {Palette} p @param {number} age @param {Float32Array | number[]} out length ≥ 3
 */
export function trailColor(p, age, out) {
  let u = age / TRAIL_OLD;
  u = u > 0 ? (u < 1 ? u : 1) : 0;
  const a = u < 0.5 ? p.hot : p.warm;
  const b = u < 0.5 ? p.warm : p.old;
  const f = u < 0.5 ? u * 2 : u * 2 - 1;
  for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * f;
  return out;
}

export const BACKDROPS = ["black", "none"];

/**
 * Opacity of the gaps between the lines. "black" (default) fills them with the palette's gap
 * colour, as on the album cover; "none" leaves them transparent, so the lines, sphere and trail
 * float on whatever the shell shows behind the canvas (black, or the desktop).
 * @param {string} backdrop
 */
export function gapOpacity(backdrop) {
  return backdrop === "none" ? 0 : 1;
}

/** A beat brightens the whole frame by at most this fraction. */
export const GLOW_MAX = 0.25;
const GLOW_DECAY = 0.15; // s

/**
 * The frame's global brightness, `value` = 1 … 1 + GLOW_MAX: each beat (strength × Reactivity)
 * lifts it and it decays over ~0.15 s. The lift goes through the photosensitivity limiter
 * (lib/flash.js), so with reduceFlashing a new rise starts at most 3 times per second.
 */
export function createGlow() {
  const limiter = createFlashLimiter();
  let env = 0;
  return {
    value: 1,
    /**
     * @param {boolean} onset @param {number} strength ≈0–1 @param {number} dt seconds
     * @param {boolean} reduceFlashing @param {number} reactivity 0–2
     */
    step(onset, strength, dt, reduceFlashing, reactivity) {
      env *= Math.exp(-dt / GLOW_DECAY);
      if (onset) {
        const st = Number.isFinite(strength) ? (strength < 0 ? 0 : strength > 1 ? 1 : strength) : 0;
        let h = (0.5 + 0.5 * st) * (reactivity > 0 ? reactivity : 0);
        h = h > 1 ? 1 : h;
        if (h > env) env = h;
      }
      this.value = 1 + GLOW_MAX * limiter.step(env, dt, reduceFlashing);
    },
    reset() {
      env = 0;
      limiter.reset();
      this.value = 1;
    },
  };
}

/** Manifest defaults for the motion params (a test keeps tidalviz.json in step). */
export const MOTION_DEFAULTS = { speed: 1, turbulence: 1, reactivity: 1 };
/** What those defaults become under macOS "Reduce motion": a slower, calmer stream. */
export const REDUCED_MOTION = { speed: 0.55, turbulence: 0.45, reactivity: 0.5 };

/**
 * Effective flow speed, turbulence and reactivity. With `reduceMotion`, a param still at its
 * manifest default is swapped for the calmer value; a value the user chose is respected.
 * @param {Record<string, unknown>} params live ctx.params
 * @param {boolean} reduceMotion
 * @param {{ speed: number, turbulence: number, reactivity: number }} out
 */
export function motion(params, reduceMotion, out) {
  const s = Number(params.speed ?? MOTION_DEFAULTS.speed);
  const t = Number(params.turbulence ?? MOTION_DEFAULTS.turbulence);
  const r = Number(params.reactivity ?? MOTION_DEFAULTS.reactivity);
  out.speed = reduceMotion && s === MOTION_DEFAULTS.speed ? REDUCED_MOTION.speed : s;
  out.turbulence = reduceMotion && t === MOTION_DEFAULTS.turbulence ? REDUCED_MOTION.turbulence : t;
  out.reactivity = reduceMotion && r === MOTION_DEFAULTS.reactivity ? REDUCED_MOTION.reactivity : r;
  return out;
}
