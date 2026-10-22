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
export const WAVE_RESERVE = 1.6;
export const RIPPLE_RESERVE = 5.4;
export const BULGE_RESERVE = 1;
export const EMIT_RESERVE = 2.2;
export const DUTY_RESERVE = 0.4;
export const DRIVE_BUDGET = RATE_BUDGET - WAVE_RESERVE - RIPPLE_RESERVE - BULGE_RESERVE - EMIT_RESERVE - DUTY_RESERVE;
/** Most of the drive's budget the shape changes (flow, twist, breathing) may take before the drift. */
const SHAPE_SHARE = 0.5;
/** Most of the shape budget the twist may take. */
const TWIST_SHARE = 0.85;
/** How much bassAtt breathes the stripe frequency (±, at Reactivity 1), and how fast it may. */
export const BREATHE = 0.08;
const BREATHE_TAU = 0.5;
const BREATHE_SLEW = 0.4; // rad per unit of field, per second
/** Flow (units/s) at Speed 1 and full energy; the marble warp evolves with it. */
export const FLOW_RATE = 0.04;
/** Outward drift (rad/s of phase) at Speed 1: idle (silence) and added at full energy. */
export const DRIFT_IDLE = 0.3;
export const DRIFT_GAIN = 1.2;
/**
 * Extra drift (rad/s) a full beat surge adds (by surge², so weak onsets only nudge): the loops
 * lurch outward on each beat, within what the budget leaves.
 */
export const SURGE_DRIFT = 6;
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
      const drift = speed * (DRIFT_IDLE + react * (DRIFT_GAIN * energy + SURGE_DRIFT * surge * surge));
      const dphase = Math.min(drift * dt, budget - used);

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
 * Stripe thickness from bass hits: the black bands fatten on a hit and relax. A whole-field
 * brightness change, so it goes through the shared flash limiter (with reduceFlashing at most
 * 3 new swells a second), and it's slewed so the stripe edges (at asin(threshold) of phase) move
 * no faster than DUTY_RESERVE rad/s: a swell, not a flicker.
 */
export function createThickness() {
  const flash = createFlashLimiter();
  let env = 0;
  let out = 0;
  return {
    /**
     * @param {number} bass `audio.bass` (1 = average)
     * @param {number} reactivity Reactivity param
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing
     * @returns {number} threshold for stripe(), 0 to DUTY_MAX
     */
    step(bass, reactivity, dt, reduceFlashing) {
      if (!(dt > 0)) return out;
      env *= Math.exp(-dt / 0.4);
      env = Math.max(env, clamp(((bass || 0) - 1) * 0.5 * clamp(reactivity, 0, 2), 0, 1));
      const target = DUTY_MAX * clamp(flash.step(env, dt, reduceFlashing), 0, 1);
      // d(asin x)/dt = x'/√(1 − x²) ≤ x'/√(1 − DUTY_MAX²)
      const max = DUTY_RESERVE * Math.sqrt(1 - DUTY_MAX * DUTY_MAX) * dt;
      out += clamp(target - out, -max, max);
      return out;
    },
  };
}

/** Ripple ring speed (screen units/s, half the short side = 1), width and fade (s to 1/e). */
export const RIPPLE_SPEED = 0.75;
export const RIPPLE_WIDTH = 0.3;
export const RIPPLE_TAU = 2;
/** Phase (rad) a full-strength ripple shifts the stripes by at its crest. */
export const RIPPLE_PHASE = 2;
/**
 * Rings are born this far inside the skull's silhouette (in units of the outline distance, which is
 * negative inside), so they rise out from under the skull instead of popping up at its edge.
 */
export const RIPPLE_BIRTH = -2.2 * RIPPLE_WIDTH;
/** A ripple ends past this radius (off any screen) or below 1% amplitude. */
const RIPPLE_END_R = 3.2;
/**
 * Most total ripple strength alive at once. A ring's phase at distance d is
 * RIPPLE_PHASE·a·exp(−x²), x = (d − radius)/RIPPLE_WIDTH, so it changes at most
 * RIPPLE_PHASE·a·(√(2/e)·RIPPLE_SPEED/RIPPLE_WIDTH + 1/RIPPLE_TAU) rad/s: capping Σa keeps every
 * point within RIPPLE_RESERVE.
 */
export const RIPPLE_SUM = RIPPLE_RESERVE / (RIPPLE_PHASE * (Math.sqrt(2 / Math.E) * (RIPPLE_SPEED / RIPPLE_WIDTH) + 1 / RIPPLE_TAU));

/**
 * Beat ripples: a preallocated ring of `cap` rings expanding from the skull across the screen.
 * `data` holds (radius, amplitude) per ring, ready for a vec2 uniform array; ended rings have
 * amplitude 0. A spawn is cut down to what the RIPPLE_SUM cap leaves.
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
      let alive = 0;
      let free = -1;
      for (let k = 0; k < cap; k++) {
        const i = (next + k) % cap;
        alive += r.data[2 * i + 1];
        if (free < 0 && r.data[2 * i + 1] === 0) free = i;
      }
      const a = clamp(Math.min(s, RIPPLE_SUM - alive), 0, 1);
      if (free < 0 || !(a > 0.05)) return; // never cut a live ring off: that would jump
      next = free;
      age[next] = 0;
      strength[next] = a;
      r.data[2 * next] = RIPPLE_BIRTH;
      r.data[2 * next + 1] = a;
      next = (next + 1) % cap;
    },
    /** @param {number} dt */
    step(dt) {
      for (let i = 0; i < cap; i++) {
        age[i] += dt;
        const radius = RIPPLE_BIRTH + age[i] * RIPPLE_SPEED;
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
 * opart.glsl ripplePhase(): the phase (rad) the rings add at outline distance `d` from the skull
 * (negative inside it, where the skull covers the stripes).
 * @param {number} d @param {Float32Array} data createRipples data
 */
export function ripplePhase(d, data) {
  let s = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const x = (d - data[i]) / RIPPLE_WIDTH;
    s += data[i + 1] * Math.exp(-x * x);
  }
  return RIPPLE_PHASE * s;
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
      if (onset) env = clamp(clamp(onsetStrength || 0, 0, 1) * clamp(gain, 0, 2), 0, 1);
      const v = flash.step(env, dt, reduceFlashing);
      const launch = onset && v > prev + 1e-6 ? v : 0;
      prev = v;
      return launch;
    },
  };
}

/** Waveform bend: most phase (rad) it shifts a stripe by, and how fast (units/s) it may change. */
export const WAVE_PHASE = 2;
export const WAVE_SLEW = 0.8;

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
export const TWIST_MAX = 1.1;
/** How fast the twist falls off with distance from the skull (1/screen units). */
export const TWIST_FALLOFF = 0.8;
/** Largest |∂field/∂twist| outside the skull's bounding circle (checked against the mirror). */
export const TWIST_SENS = 0.65;
/** Smooth-min width (screen units) where an emitter's loops merge with the skull's. */
export const EMIT_K = 0.035;

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
export const SURGE_TAU = 0.15;

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

/** Most phase (rad) the spectrum bulge pushes the stripes outward by, and how fast it may change. */
export const BULGE_PHASE = 2;
export const BULGE_SLEW = BULGE_RESERVE / BULGE_PHASE;
/** Band level (0–1 display scale) below which a sector doesn't bulge. */
const BULGE_FLOOR = 0.15;

/**
 * The spectrum mapped round the skull, for bulging the stripes outward where the mix is loud:
 * `n` sectors from straight up (sector 0: the highs, over the cranium) to straight down (sector
 * n − 1: the bass, under the jaw), mirrored left/right in the shader. Each sector takes the
 * loudest of its share of the 64 host bands; levels slew at BULGE_SLEW so the bulge stays within
 * BULGE_RESERVE of phase a second.
 * @param {number} n
 */
export function createBulge(n) {
  const out = new Float32Array(n);
  return {
    /**
     * @param {Float32Array} bands `audio.bands` (any length), 0–1
     * @param {number} reactivity Reactivity param
     * @param {number} dt seconds
     * @returns {Float32Array} n levels 0–1 (the same array every call)
     */
    step(bands, reactivity, dt) {
      const len = bands.length;
      const max = BULGE_SLEW * Math.max(0, dt);
      const react = clamp(reactivity, 0, 2);
      for (let i = 0; i < n; i++) {
        // Sector i (top → bottom) reads bands from the top of the spectrum down.
        const a = Math.floor(((n - 1 - i) * len) / n);
        const b = Math.max(a + 1, Math.floor(((n - i) * len) / n));
        let v = 0;
        for (let j = a; j < b && j < len; j++) if (bands[j] > v) v = bands[j]; // NaN never wins
        const target = clamp(((Math.min(v, 1) - BULGE_FLOOR) / (1 - BULGE_FLOOR)) * 0.6 * react, 0, 1);
        out[i] += clamp(target - out[i], -max, max);
      }
      return out;
    },
  };
}

/** An idle emitter's offset: far above any field value on screen, so it changes nothing. */
export const EMIT_IDLE = 50;
/** Seconds an emitter keeps pouring loops out before it winds down, and how deep it sinks. */
export const EMIT_LIFE = 6;
const EMIT_DEPTH = 0.35;
/** Clearance above the skull's field an emitter starts (and ends) at, so it appears from nothing. */
const EMIT_CLEAR = EMIT_K + 0.01;

/**
 * Loop emitters: points round the skull where new closed loops are born and grow outward, merged
 * with the skull's own loops by a smooth minimum (opart.glsl opField). Each emitter's term is
 * |q − e| + offset. It starts with its offset just above the skull's field at e (no effect), sinks
 * (a dimple, then closed loops pinch off and grow), pours loops for EMIT_LIFE s, then rises back
 * and retires. The field moves at EMIT_RESERVE / freq units a second at most, so no pixel's phase
 * changes faster than EMIT_RESERVE from it. A preallocated pool: `data` holds (x, y, offset, 0) per slot
 * for a vec4 uniform array; idle slots have offset EMIT_IDLE.
 * @param {number} cap
 */
export function createEmitters(cap) {
  const data = new Float32Array(cap * 4);
  const age = new Float32Array(cap);
  const floor = new Float32Array(cap);
  const active = new Uint8Array(cap);
  for (let i = 0; i < cap; i++) data[4 * i + 2] = EMIT_IDLE;
  const em = {
    data,
    /** Emitters alive. */
    count: 0,
    /**
     * Start an emitter at (x, y) (screen units, skull at the origin) if a slot is free and the spot
     * is clear of the skull.
     * @param {number} x @param {number} y @param {number[]} outline u_outline [scale, tilt, jaw drop]
     * @returns {boolean} whether it started
     */
    spawn(x, y, outline) {
      const line = outlineField(x, y, outline);
      if (!(line > 0.1)) return false;
      for (let i = 0; i < cap; i++) {
        if (active[i]) continue;
        active[i] = 1;
        age[i] = 0;
        floor[i] = Math.max(0, line - EMIT_DEPTH);
        data[4 * i] = x;
        data[4 * i + 1] = y;
        data[4 * i + 2] = line + EMIT_CLEAR;
        em.count++;
        return true;
      }
      return false;
    },
    /**
     * @param {number} dt seconds
     * @param {number} freq stripe frequency (rad per unit of field)
     * @param {number[]} outline u_outline
     * @param {boolean} reduceFlashing
     */
    step(dt, freq, outline, reduceFlashing) {
      if (!(dt > 0)) return em;
      const max = (EMIT_RESERVE * (reduceFlashing ? 1 : FREE_FACTOR) * dt) / Math.max(freq, 1);
      for (let i = 0; i < cap; i++) {
        if (!active[i]) continue;
        age[i] += dt;
        const o = 4 * i + 2;
        const line = outlineField(data[4 * i], data[4 * i + 1], outline);
        const top = line + EMIT_CLEAR;
        const target = age[i] < EMIT_LIFE ? floor[i] : top;
        data[o] += clamp(target - data[o], -max, max);
        if (age[i] >= EMIT_LIFE && data[o] >= top - 1e-4) {
          active[i] = 0;
          data[o] = EMIT_IDLE;
          em.count--;
        }
      }
      return em;
    },
  };
  return em;
}

/**
 * Where a new emitter goes: at the angle of bulge sector `sector` of `n` (0 straight up … n − 1
 * straight down), on the left (side −1) or right (+1), at an outline distance between 0.3 and 0.7
 * chosen by the golden ratio from `seq` (so successive emitters spread out). Deterministic; writes
 * (x, y) into `out`.
 * @param {number} sector @param {number} n @param {number} side @param {number} seq
 * @param {number[]} outline u_outline @param {Float32Array} out
 */
export function emitterSpot(sector, n, side, seq, outline, out) {
  const a = (Math.PI * (clamp(sector, 0, n - 1) + 0.5)) / n;
  const dx = (side < 0 ? -1 : 1) * Math.sin(a);
  const dy = Math.cos(a);
  const want = 0.3 + 0.4 * ((seq * 0.6180339887) % 1);
  let lo = 0;
  let hi = 4;
  for (let i = 0; i < 24; i++) {
    const m = 0.5 * (lo + hi);
    if (outlineField(m * dx, m * dy, outline) < want) lo = m;
    else hi = m;
  }
  out[0] = lo * dx;
  out[1] = lo * dy;
  return out;
}

/** A GLSL float literal. @param {number} v */
const glslFloat = (v) => {
  const s = String(v);
  return /[.e]/.test(s) ? (s.includes(".") ? s : s.replace("e", ".0e")) : s + ".0";
};

/**
 * #defines for shaders/skull/opart.glsl: the array sizes and the constants the anti-strobe bounds
 * were checked with, so the shader and these tests can't drift apart.
 * @param {{ ripples: number, wave: number, emitters: number, sectors: number }} n array sizes
 */
export function opartDefines(n) {
  const ints = { RIPPLES: n.ripples, WAVE_POINTS: n.wave, EMITTERS: n.emitters, BULGE_SECTORS: n.sectors };
  const floats = { WAVE_PHASE, RIPPLE_PHASE, RIPPLE_WIDTH, BULGE_PHASE, EMIT_K, TWIST_FALLOFF };
  let s = "";
  for (const [k, v] of Object.entries(ints)) s += `#define ${k} ${Math.round(v)}\n`;
  for (const [k, v] of Object.entries(floats)) s += `#define ${k} ${glslFloat(v)}\n`;
  return s;
}
