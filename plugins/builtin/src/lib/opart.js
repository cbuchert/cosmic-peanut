// @ts-check
/**
 * Skull Trip's op-art stripes, mirrored from shaders/skull/opart.glsl: the anti-aliased stripe,
 * the stripe drive (phase, frequency, flow, thickness) with its anti-strobe budget, the beat
 * ripples and the colours. Nothing allocates per step.
 */
import { createFlashLimiter } from "./flash.js";

/**
 * @param {number} v sin(phase), −1..1
 * @param {number} w anti-aliasing half-width in units of v (fwidth in the shader)
 * @param {number} t threshold: > 0 thins the white stripes, < 0 thickens them
 */
export function stripe(v, w, t) {
  const s = 0.5 + (v - t) / (2 * Math.max(w, 1e-6));
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/** Stripe frequency (radians of phase per unit of field) at Density 1. */
export const BASE_K = 32;
/** Largest |field value| on screen, including warp (screen units, half the short side = 1). */
export const FIELD_MAX = 2.8;
/**
 * Largest |∂field/∂flow| per unit of Warp outside the skull's bounding circle (checked against the
 * mirrored field in tests; inside, the skull covers the stripes).
 */
export const FLOW_SENS = 1;

/**
 * Fastest any pixel may alternate black → white → black with reduceFlashing (WCAG: 3 flashes/s).
 * One alternation is 2π of stripe phase.
 */
export const MAX_ALT_HZ = 3;
/** Phase-rate budget (rad/s) at the worst pixel with reduceFlashing: MAX_ALT_HZ with 10% headroom. */
export const RATE_BUDGET = 0.9 * 2 * Math.PI * MAX_ALT_HZ;
/** How much more the budget allows with reduceFlashing off. */
export const FREE_FACTOR = 2.5;
/**
 * Parts of RATE_BUDGET kept for the local effects, each bounded where it's made: the waveform bend
 * (createWaveBend), beat ripples (createRipples), the spectrum bulge (createBulge), the emitters
 * (createEmitters) and the stripe thickness (createThickness). The drive (createStripeDrive) gets
 * the rest, so the sum at any pixel stays within RATE_BUDGET.
 */
export const WAVE_RESERVE = 2;
export const RIPPLE_RESERVE = 4.5;
export const BULGE_RESERVE = 1.2;
export const EMIT_RESERVE = 1.6;
export const DUTY_RESERVE = 0.4;
export const DRIVE_BUDGET = RATE_BUDGET - WAVE_RESERVE - RIPPLE_RESERVE - BULGE_RESERVE - EMIT_RESERVE - DUTY_RESERVE;
/** Most of the drive's budget the shape changes (flow, twist, breathing) may take before the drift. */
const SHAPE_SHARE = 0.5;
/** Most of the shape budget the twist may take. */
const TWIST_SHARE = 0.8;
/** How much bassAtt breathes the stripe frequency (±, at Reactivity 1), and how fast it may. */
export const BREATHE = 0.08;
const BREATHE_TAU = 0.5;
const BREATHE_SLEW = 0.4; // rad per unit of field, per second
/** Flow (units/s) at Speed 1 and full energy; the marble warp evolves with it. */
export const FLOW_RATE = 0.04;
/** Outward drift (rad/s of phase) at Speed 1: idle (silence) and added at full energy. */
export const DRIFT_IDLE = 0.45;
export const DRIFT_GAIN = 3.5;
/** Extra drift a full beat surge adds, as a fraction of DRIFT_GAIN. */
export const SURGE_DRIFT = 0.8;
/** Fastest the whirlpool's twist may change (rad/s) before the budget. */
const TWIST_SLEW = 0.35;

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * The stripes' global motion: the outward drift (new loops are born at the skull and the emitters
 * and grow off the screen), the frequency breathing with the bass, the marble flow, and the
 * whirlpool's twist. Energy speeds the drift and the flow and tightens the whirlpool, a beat surge
 * kicks the drift, and the twist turns with the phrase direction (`dir`).
 *
 * Anti-strobe: the worst pixel's phase rate, |dk|·FIELD_MAX + drift + freq·(FLOW_SENS·warp·flow' +
 * TWIST_SENS·|twist'|), stays within DRIVE_BUDGET (×FREE_FACTOR with reduceFlashing off). The shape
 * changes take at most SHAPE_SHARE of it; the drift gets the rest.
 */
export function createStripeDrive() {
  const d = {
    /** Global phase (rad), subtracted from freq·field: stripes stream outward as it grows. */
    phase: 0,
    /** Stripe frequency (rad per unit of field). */
    freq: BASE_K,
    /** Warp-field clock. */
    flow: 0,
    /** Whirlpool angle at the centre (rad), signed by the swirl direction. */
    twist: 0,
    /** Stripe threshold (thickness): see createThickness. */
    duty: 0,
    /**
     * @param {number} dt
     * @param {{ density: number, speed: number, warp: number, reactivity: number, bassAtt: number,
     *   energy: number, surge: number, dir: number }} input
     * @param {boolean} reduceFlashing
     */
    step(dt, input, reduceFlashing) {
      if (!(dt > 0)) return d;
      const density = clamp(input.density, 0.25, 3);
      const speed = clamp(input.speed, 0, 3);
      const warp = clamp(input.warp, 0, 3);
      const react = clamp(input.reactivity, 0, 2);
      const energy = clamp(input.energy || 0, 0, 1.5);
      const surge = clamp(input.surge || 0, 0, 1);
      const dir = clamp(input.dir || 0, -1, 1);
      const budget = DRIVE_BUDGET * (reduceFlashing ? 1 : FREE_FACTOR) * dt;

      const target = BASE_K * density * (1 + BREATHE * react * 0.5 * clamp((input.bassAtt || 0) - 1, -1, 1));
      let dk = clamp((target - d.freq) * (1 - Math.exp(-dt / BREATHE_TAU)), -BREATHE_SLEW * dt, BREATHE_SLEW * dt);
      let dflow = FLOW_RATE * speed * (0.25 + 0.75 * Math.min(1, react * energy) + 0.2 * react * surge) * dt;
      const twistTarget = dir * warp * TWIST_MAX * (0.25 + 0.6 * Math.min(1, react * energy));
      let dtwist = clamp(twistTarget - d.twist, -TWIST_SLEW * dt, TWIST_SLEW * dt);
      const k = d.freq + Math.abs(dk);
      // The twist goes first (a reversal shouldn't crawl), then the breathing and the flow share
      // what's left of the shape budget.
      const shapeMax = SHAPE_SHARE * budget;
      const twistCost = k * TWIST_SENS * Math.abs(dtwist);
      if (twistCost > TWIST_SHARE * shapeMax) dtwist *= (TWIST_SHARE * shapeMax) / twistCost;
      const twistUsed = Math.min(twistCost, TWIST_SHARE * shapeMax);
      const rest = Math.abs(dk) * FIELD_MAX + k * FLOW_SENS * warp * dflow;
      if (rest > shapeMax - twistUsed) {
        const s = (shapeMax - twistUsed) / rest;
        dk *= s;
        dflow *= s;
      }
      const used = twistUsed + Math.min(rest, shapeMax - twistUsed);
      const dphase = Math.min(DRIFT_IDLE * speed * dt + DRIFT_GAIN * speed * react * (energy + SURGE_DRIFT * surge) * dt, budget - used);

      d.freq += dk;
      d.phase += dphase;
      d.flow += dflow;
      d.twist += dtwist;
      return d;
    },
  };
  return d;
}

/** Largest stripe threshold: white covers acos(±DUTY_MAX)/π of each period (≈ 42–58%). */
export const DUTY_MAX = 0.25;

/**
 * Stripe thickness from bass hits: the black bands fatten on a hit and relax (a whole-field
 * brightness change, so it goes through the shared flash limiter: with reduceFlashing at most
 * 3 new swells a second).
 */
export function createThickness() {
  const flash = createFlashLimiter();
  let env = 0;
  return {
    /**
     * @param {number} bass `audio.bass` (1 = average)
     * @param {number} reactivity Reactivity param
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing
     * @returns {number} threshold for stripe(), 0 to DUTY_MAX
     */
    step(bass, reactivity, dt, reduceFlashing) {
      env *= Math.exp(-dt / 0.15);
      env = Math.max(env, clamp(((bass || 0) - 1) * 0.5 * clamp(reactivity, 0, 2), 0, 1));
      return DUTY_MAX * clamp(flash.step(env, dt, reduceFlashing), 0, 1);
    },
  };
}

/** Ripple ring speed (screen units/s, half the short side = 1). */
export const RIPPLE_SPEED = 0.9;

/** Seconds for a ripple's amplitude to fall to 1/e. */
export const RIPPLE_TAU = 0.7;
/** A ripple ends past this radius (off any screen) or below 1% amplitude. */
const RIPPLE_END_R = 3.2;

/**
 * Beat ripples: a preallocated ring of `cap` rings expanding from the skull. `data` holds
 * (radius, amplitude) per ring, ready for a vec2 uniform array; ended rings have amplitude 0.
 * @param {number} cap
 */
export function createRipples(cap) {
  const age = new Float32Array(cap).fill(Infinity);
  const strength = new Float32Array(cap);
  let next = 0;
  const r = {
    data: new Float32Array(cap * 2),
    /** @param {number} s amplitude, 0–1 */
    spawn(s) {
      age[next] = 0;
      strength[next] = s;
      r.data[2 * next] = 0;
      r.data[2 * next + 1] = s;
      next = (next + 1) % cap;
    },
    /** @param {number} dt */
    step(dt) {
      for (let i = 0; i < cap; i++) {
        age[i] += dt;
        const radius = age[i] * RIPPLE_SPEED;
        const amp = strength[i] * Math.exp(-age[i] / RIPPLE_TAU);
        const alive = radius < RIPPLE_END_R && amp > 0.01 * strength[i];
        r.data[2 * i] = alive ? radius : 0;
        r.data[2 * i + 1] = alive ? amp : 0;
      }
    },
  };
  return r;
}

/**
 * Decides when a beat launches a ripple. Each onset raises an envelope (sized by its strength and
 * `gain`) that goes through the shared flash limiter; a ripple launches only where the limited
 * envelope starts a new rise, so with reduceFlashing at most 3 ripples start per second.
 */
export function createRippleTrigger() {
  const flash = createFlashLimiter();
  let env = 0;
  let prev = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} gain Reactivity × motion scale, 0–2
     * @param {number} dt
     * @param {boolean} reduceFlashing
     * @returns {number} strength of the ripple to launch now, 0 for none
     */
    step(onset, onsetStrength, gain, dt, reduceFlashing) {
      env *= Math.exp(-dt / 0.08);
      if (onset) env = clamp((0.5 + 0.5 * clamp(onsetStrength || 0, 0, 1)) * clamp(gain, 0, 2) * 0.5, 0, 1);
      const v = flash.step(env, dt, reduceFlashing);
      const launch = onset && v > prev + 1e-6 ? v : 0;
      prev = v;
      return launch;
    },
  };
}

/** Waveform bend: most phase (rad) it shifts a stripe by, and how fast (units/s) it may change. */
export const WAVE_PHASE = 1;
export const WAVE_SLEW = 1.5;

/**
 * The waveform, block-averaged into `n` points and slew-limited, for bending the stripes around
 * the skull (the shader mirrors it left/right). Slew limiting keeps a noisy waveform from making
 * the stripes jitter: with WAVE_PHASE × WAVE_SLEW ≤ WAVE_RESERVE it stays inside the anti-strobe
 * budget. Reads `waveform.length`, so any length works.
 * @param {number} n
 */
export function createWaveBend(n) {
  const out = new Float32Array(n);
  return {
    /**
     * @param {Float32Array} waveform `audio.waveform`, −1..1
     * @param {number} dt
     * @returns {Float32Array} n values in −1..1 (the same array every call)
     */
    step(waveform, dt) {
      const len = waveform.length;
      const maxStep = WAVE_SLEW * Math.max(0, dt);
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i * len) / n);
        const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
        let sum = 0;
        for (let j = a; j < b && j < len; j++) {
          const x = waveform[j];
          if (x > -2 && x < 2) sum += x; // skips NaN and wild values
        }
        const target = clamp((len ? sum / (b - a) : 0) * 1.5, -1, 1);
        out[i] += clamp(target - out[i], -maxStep, maxStep);
      }
      return out;
    },
  };
}

/** Mode and Stripes select options (manifest order; the first is the default). */
export const MODES = Object.freeze(["monochrome", "acid"]);
export const STRIPES = Object.freeze(["black & white", "black only"]);

/**
 * The look from the Mode and Stripes params: acid tints, and whether the white stripes are paper
 * (alpha 1) or transparent (alpha 0, "black only": the skull and black stripes float on the
 * desktop). Unknown values fall back to the defaults.
 * @param {unknown} mode
 * @param {unknown} stripes
 * @param {{ acid: boolean, paperAlpha: number }} out
 */
export function resolveLook(mode, stripes, out) {
  out.acid = mode === "acid";
  out.paperAlpha = stripes === "black only" ? 0 : 1;
  return out;
}

/** Seconds for the acid tints to go once round the hue circle. */
export const ACID_PERIOD = 30;

/**
 * Ink (out[0..2]) and paper (out[3..5]) colours. Monochrome is pure black on white; acid tints
 * both with slowly rotating hues (the paper a third of the way round from the ink), keeping the
 * ink dark and the paper light so the op-art stays bold.
 * @param {boolean} acid
 * @param {number} clock seconds
 * @param {Float32Array} out length ≥ 6
 */
export function lookColors(acid, clock, out) {
  if (!acid) {
    out[0] = out[1] = out[2] = 0;
    out[3] = out[4] = out[5] = 1;
    return out;
  }
  const h = clock / ACID_PERIOD;
  for (let i = 0; i < 3; i++) {
    const ink = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + i / 3));
    const paper = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.4 + i / 3));
    out[i] = 0.18 * ink;
    out[3 + i] = 0.6 + 0.4 * paper;
  }
  return out;
}

const fract = (/** @type {number} */ x) => x - Math.floor(x);

/** opart.glsl hash12 (values differ slightly from the GPU's floats; only the bounds matter). */
function hash12(/** @type {number} */ x, /** @type {number} */ y) {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fract((a + b) * c);
}

function vnoise(/** @type {number} */ x, /** @type {number} */ y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy) + (hash12(ix + 1, iy) - hash12(ix, iy)) * ux;
  const b = hash12(ix, iy + 1) + (hash12(ix + 1, iy + 1) - hash12(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

function fbm(/** @type {number} */ x, /** @type {number} */ y) {
  let s = 0.5 * vnoise(x, y);
  x = x * 2.03 + 1.7;
  y = y * 2.03 + 9.2;
  s += 0.25 * vnoise(x, y);
  x = x * 2.03 + 1.7;
  y = y * 2.03 + 9.2;
  s += 0.125 * vnoise(x, y);
  return s / 0.875;
}

function sdEllipse2(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ rx, /** @type {number} */ ry) {
  const k0 = Math.hypot(x / rx, y / ry);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry));
  return (k0 * (k0 - 1)) / Math.max(k1, 1e-4);
}

function smin(/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

/** Most twist (radians at the skull's centre) per unit of Warp: the whirlpool at its tightest. */
export const TWIST_MAX = 1.3;
/** How fast the twist falls off with distance from the skull (1/screen units). */
export const TWIST_FALLOFF = 0.8;
/** Largest |∂field/∂twist| outside the skull's bounding circle (checked against the mirror). */
export const TWIST_SENS = 0.65;
/** Smooth-min width (screen units) where an emitter's loops merge with the skull's. */
export const EMIT_K = 0.12;

/**
 * @typedef {{ flow: number, warp: number, outline: number[], twist?: number, emitters?: Float32Array }} FieldState
 * outline: [screen units per object unit, tilt, jaw drop] (u_outline); twist: the whirlpool's
 * angle at the centre (u_twist); emitters: (x, y, offset, -) per emitter (u_emitters).
 */

/**
 * The stripe field of shaders/skull/opart.glsl opField, in JS, for tests of its bounds (FIELD_MAX,
 * FLOW_SENS, TWIST_SENS, which the anti-strobe budget relies on). Keep the two in step.
 * @param {number} x screen units, skull at the origin
 * @param {number} y
 * @param {FieldState} st
 */
export function opField(x, y, st) {
  const { flow, warp, outline } = st;
  const twist = st.twist ?? 0;
  const ox = fbm(x * 0.8, y * 0.8 + 0.5 * flow);
  const oy = fbm(x * 0.8 + 5.2 - 0.4 * flow, y * 0.8 + 1.3);
  let qx = x + warp * 0.42 * (ox * 2 - 1);
  let qy = y + warp * 0.42 * (oy * 2 - 1);
  const r = Math.hypot(qx, qy);
  const a = twist * Math.exp(-TWIST_FALLOFF * r);
  const c = Math.cos(a);
  const s = Math.sin(a);
  [qx, qy] = [c * qx - s * qy, s * qx + c * qy];
  let line = outlineField(qx, qy, outline);
  const em = st.emitters;
  if (em) for (let i = 0; i + 3 < em.length; i += 4) line = smin(line, Math.hypot(qx - em[i], qy - em[i + 1]) + em[i + 2], EMIT_K);
  return line + 0.25 * warp * (fbm(qx * 1.6 - 0.3 * flow, qy * 1.6) - 0.5);
}

/**
 * opart.glsl outline(): signed distance (screen units, roughly) to the skull's silhouette.
 * @param {number} qx @param {number} qy @param {number[]} outline [scale, tilt, jaw drop]
 */
export function outlineField(qx, qy, outline) {
  const [k, tilt, drop] = outline;
  const ct = Math.cos(-tilt);
  const st = Math.sin(-tilt);
  const px = (ct * qx - st * qy) / k;
  const py = (st * qx + ct * qy) / k;
  const cranium = sdEllipse2(px, py - 0.2, 0.95, 1.0);
  const jaw = sdEllipse2(px, py + 0.72 + drop, 0.52, 0.34);
  return smin(cranium, jaw, 0.3) * k;
}

/** Loudness range (dBFS of `audio.rms`) the stripes' drive maps onto 0–1. */
export const LOUD_FLOOR_DB = -42;
export const LOUD_TOP_DB = -14;

/**
 * How loud the music is, 0–1, from the raw (un-gained) `audio.rms`: 0 at or below LOUD_FLOOR_DB
 * (silence, room noise), 1 from LOUD_TOP_DB (mastered music), linear in dB between.
 * @param {number} rms
 */
export function loudness(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return clamp((db - LOUD_FLOOR_DB) / (LOUD_TOP_DB - LOUD_FLOOR_DB), 0, 1);
}

/** Seconds for the energy level to rise toward louder music, and to fall back when it quietens. */
const ENERGY_ATTACK = 0.3;
const ENERGY_RELEASE = 1.2;
/** Seconds for a beat surge to fall to 1/e. */
export const SURGE_TAU = 0.22;

/**
 * The music's energy for the stripes: `level` (0–1.3), the loudness weighted by the bass, smoothed
 * (fast attack, slow release, so a loud passage spins things up and a quiet one lets them relax),
 * and `surge` (0–1), a short envelope each onset raises, sized by its strength. Exponential
 * smoothing, so 60 Hz and 120 Hz displays follow the same curve.
 */
export function createEnergy() {
  const e = {
    level: 0,
    surge: 0,
    /**
     * @param {{ rms: number, bassAtt: number, onset: boolean, onsetStrength: number, silent: boolean }} audio
     * @param {number} dt seconds
     */
    step(audio, dt) {
      if (!(dt > 0)) return e;
      const loud = audio.silent ? 0 : loudness(audio.rms);
      const target = loud * (0.7 + 0.3 * clamp(audio.bassAtt || 0, 0, 2));
      const tau = target > e.level ? ENERGY_ATTACK : ENERGY_RELEASE;
      e.level += (target - e.level) * (1 - Math.exp(-dt / tau));
      e.surge *= Math.exp(-dt / SURGE_TAU);
      if (audio.onset && !audio.silent) e.surge = Math.max(e.surge, clamp(audio.onsetStrength || 0, 0, 1) * (0.4 + 0.6 * loud));
      return e;
    },
  };
  return e;
}

/** Beats per phrase (8 bars of 4/4): the swirl reverses at each phrase boundary. */
export const PHRASE_BEATS = 32;
/** Fastest the swirl direction may change (per second): a full reversal takes 2 / REVERSE_RATE s. */
export const REVERSE_RATE = 0.8;
/** Without a tempo: seconds between reversals at least, and the energy change that triggers one. */
const PHRASE_MIN_S = 8;
const PHRASE_JUMP = 0.25;

/**
 * The swirl's direction, −1..1: it reverses at phrase boundaries (every PHRASE_BEATS beats while
 * the tempo is confident, counted where beatPhase wraps), or without a tempo when the energy
 * changes for good (a fast average leaves a slow one by PHRASE_JUMP, at most every PHRASE_MIN_S).
 * The direction slews at REVERSE_RATE, so the whirlpool slows, stops and spins back. Deterministic.
 */
export function createPhrase() {
  let dir = 1;
  let target = 1;
  let beats = 0;
  let lastPhase = 0;
  let fast = 0;
  let slow = 0;
  let since = 0;
  let armed = true;
  return {
    /**
     * @param {number} bpm `audio.bpm` (0 until confident)
     * @param {number} beatPhase `audio.beatPhase`
     * @param {number} energy createEnergy level
     * @param {number} dt seconds
     * @returns {number} direction, −1..1
     */
    step(bpm, beatPhase, energy, dt) {
      if (!(dt > 0)) return dir;
      since += dt;
      const ph = clamp(beatPhase || 0, 0, 1);
      if (bpm > 0) {
        if (ph < lastPhase - 0.5 && ++beats >= PHRASE_BEATS) {
          beats = 0;
          target = -target;
        }
      } else {
        beats = 0;
      }
      lastPhase = ph;
      const e = clamp(energy || 0, 0, 2);
      fast += (e - fast) * (1 - Math.exp(-dt / 1));
      slow += (e - slow) * (1 - Math.exp(-dt / 8));
      const gap = Math.abs(fast - slow);
      if (!(bpm > 0) && armed && gap > PHRASE_JUMP && since >= PHRASE_MIN_S) {
        target = -target;
        since = 0;
        armed = false;
      }
      if (gap < 0.4 * PHRASE_JUMP) armed = true;
      const max = REVERSE_RATE * dt;
      dir += clamp(target - dir, -max, max);
      return dir;
    },
  };
}
