// @ts-check
/**
 * Pure, allocation-free helpers for Blaze (the waveform-seeded fire). Everything here runs on the
 * CPU once per frame (or once per param change) and is unit-tested; the GPU side lives in
 * shaders/blaze/.
 */
import { createFlashLimiter } from "./flash.js";

/** Newest samples that feed the fuel line (the frame contract's waveform length). */
export const SEED_WINDOW = 2048;

/**
 * Resample the waveform into the fire's fuel line. Each output texel is one point sample, linearly
 * interpolated between its two nearest input samples, so the waveform's jaggedness survives (no
 * box averaging). Uses the newest SEED_WINDOW samples (or all, if fewer). `mag` gets the interpolated |w|, `signed` the interpolated w.
 * @param {ArrayLike<number>} wave
 * @param {Float32Array} mag
 * @param {Float32Array} signed
 */
export function resampleSeed(wave, mag, signed) {
  const len = wave.length;
  const S = mag.length;
  if (len === 0) {
    mag.fill(0);
    signed.fill(0);
    return;
  }
  const n = len < SEED_WINDOW ? len : SEED_WINDOW;
  const start = len - n;
  const step = S > 1 ? (n - 1) / (S - 1) : 0;
  for (let i = 0; i < S; i++) {
    const x = start + i * step;
    const i0 = Math.floor(x);
    const i1 = i0 + 1 < len ? i0 + 1 : len - 1;
    const f = x - i0;
    const a = wave[i0];
    const b = wave[i1];
    signed[i] = a + (b - a) * f;
    const aa = a < 0 ? -a : a;
    const bb = b < 0 ? -b : b;
    mag[i] = aa + (bb - aa) * f;
  }
}

/**
 * Loudness normalisation for the fuel line, so a quiet source still burns: tracks the waveform
 * peak (instant attack, slow exponential release) and returns the gain that brings it to `target`.
 * The gain is capped at `maxGain`, so genuinely quiet passages stay low and silence stays out.
 * @param {{ target?: number, maxGain?: number, release?: number }} [opts] release in seconds
 */
export function createAutoGain({ target = 0.9, maxGain = 10, release = 4 } = {}) {
  const floor = target / maxGain;
  let env = 0;
  return {
    target,
    /** @param {number} level newest peak |w| @param {number} dt seconds */
    step(level, dt) {
      const decayed = env * Math.exp(-dt / release);
      env = level > decayed ? level : decayed;
      return target / (env > floor ? env : floor);
    },
    reset() {
      env = 0;
    },
  };
}

/**
 * One-pole follower with separate attack and release time constants (seconds). Exact per `dt`, so
 * it behaves the same at 60 and 120 Hz; the attack bound keeps a hit from jumping in one frame.
 * @param {number} attack
 * @param {number} release
 */
export function createEnvelope(attack, release) {
  return {
    value: 0,
    /** @param {number} target @param {number} dt seconds */
    step(target, dt) {
      const tau = target > this.value ? attack : release;
      this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
      return this.value;
    },
    reset() {
      this.value = 0;
    },
  };
}

/**
 * The music's global push on the fire, stepped once per frame:
 * - `stoke` follows the bass (1.0 = recent average) and feeds more fuel across the whole line;
 * - `flare` is thrown by an onset (bounded attack, ~0.25 s decay) and adds a burst of heat;
 * - `boost` is the combined full-frame swing the renderer uses, routed through the flash limiter,
 *   so with `reduceFlashing` it rises at most 3 times per second. `reactivity` (0–2) scales it.
 */
export function createDrive() {
  const stokeEnv = createEnvelope(0.06, 0.4);
  const flareEnv = createEnvelope(0.03, 0.2);
  const limiter = createFlashLimiter();
  let hit = 0;
  return {
    stoke: 0,
    flare: 0,
    boost: 0,
    /**
     * @param {{ bass: number, onset: boolean, onsetStrength: number }} audio
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing
     * @param {number} [reactivity] 0–2 (clamped), scales the boost; default 1
     */
    step(audio, dt, reduceFlashing, reactivity = 1) {
      hit *= Math.exp(-dt / 0.25);
      if (audio.onset) {
        const h = 0.5 + 0.5 * Math.min(1, audio.onsetStrength);
        if (h > hit) hit = h;
      }
      const bass = Number.isFinite(audio.bass) ? audio.bass : 1;
      const s = (bass - 0.7) / 1.3;
      this.stoke = stokeEnv.step(s < 0 ? 0 : s > 1 ? 1 : s, dt);
      this.flare = flareEnv.step(hit, dt);
      const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      this.boost = limiter.step(r * (0.5 * this.stoke + this.flare), dt, reduceFlashing);
    },
    reset() {
      hit = 0;
      stokeEnv.reset();
      flareEnv.reset();
      limiter.reset();
      this.stoke = this.flare = this.boost = 0;
    },
  };
}

/**
 * Fixed-timestep clock for the simulation (a dt accumulator, like Cosmic Peanut's push
 * scheduler): `step(dt)` returns how many sim steps of 1/rate s to run this frame, so the fire
 * evolves identically at 60 and 120 Hz. At most `maxSteps` per frame; a longer backlog (a stall,
 * a hidden tab) is dropped instead of being caught up in a burst.
 * @param {number} rate sim steps per second
 * @param {number} maxSteps cap per frame
 */
export function createStepper(rate, maxSteps) {
  let acc = 0;
  return {
    /** @param {number} dt seconds since the previous frame */
    step(dt) {
      acc += dt * rate;
      // A small epsilon so 1/60 s × 120 lands on exactly 2 despite float rounding.
      let n = Math.floor(acc + 1e-6);
      acc -= n;
      if (n > maxSteps) {
        n = maxSteps;
        acc = 0;
      }
      return n;
    },
    reset() {
      acc = 0;
    },
  };
}

const SIM_MIN = 16;
const SIM_MAX = 1024;

/**
 * Simulation grid size: the canvas scaled by `detail` (0.15–0.5) in each dimension, at most
 * SIM_MAX wide (aspect kept) and at least SIM_MIN in each dimension. Called on resize and on a
 * Detail change only (it allocates the returned object).
 * @param {number} width canvas drawing-buffer pixels
 * @param {number} height
 * @param {number} detail fraction of the canvas per dimension
 */
export function simSize(width, height, detail) {
  const d = Number.isFinite(detail) ? Math.min(0.5, Math.max(0.15, detail)) : 0.3;
  let w = width * d;
  let h = height * d;
  if (w > SIM_MAX) {
    h *= SIM_MAX / w;
    w = SIM_MAX;
  }
  return { width: Math.max(SIM_MIN, Math.round(w)), height: Math.max(SIM_MIN, Math.round(h)) };
}

export const PALETTES = ["natural", "blue gas", "green chemical", "ember mono"];

/**
 * Colour keys per palette: [t, r, g, b] rows, t rising from 0 (cold, black) to 1 (hottest).
 * "natural" follows a blackbody: deep red → orange → yellow → white-hot.
 * @type {Record<string, number[]>}
 */
const RAMPS = {
  natural: [
    0, 0, 0, 0,
    0.14, 0.22, 0.015, 0.0,
    0.32, 0.62, 0.08, 0.01,
    0.52, 0.96, 0.33, 0.03,
    0.72, 1.0, 0.64, 0.16,
    0.88, 1.0, 0.86, 0.5,
    1, 1.0, 0.97, 0.86,
  ],
  "blue gas": [
    0, 0, 0, 0,
    0.18, 0.01, 0.03, 0.22,
    0.4, 0.04, 0.2, 0.75,
    0.65, 0.2, 0.55, 1.0,
    0.85, 0.6, 0.85, 1.0,
    1, 0.94, 0.97, 1.0,
  ],
  "green chemical": [
    0, 0, 0, 0,
    0.18, 0.0, 0.16, 0.03,
    0.4, 0.08, 0.5, 0.08,
    0.65, 0.35, 0.85, 0.15,
    0.85, 0.72, 1.0, 0.45,
    1, 0.95, 1.0, 0.85,
  ],
  "ember mono": [
    0, 0, 0, 0,
    0.2, 0.2, 0.02, 0.0,
    0.5, 0.62, 0.1, 0.02,
    0.8, 0.95, 0.28, 0.06,
    1, 1.0, 0.5, 0.2,
  ],
};

/**
 * Sample a palette at temperature `t` (clamped to 0–1) into `out` as premultiplied RGBA: colour
 * is light-on-black and alpha is its brightest channel (docs/plugin-api.md, "The canvas is
 * transparent"), so cold gas is fully transparent rather than black smoke. Unknown palettes fall
 * back to "natural".
 * @param {string} palette
 * @param {number} t
 * @param {Float32Array | number[]} out length ≥ 4
 */
export function rampColor(palette, t, out) {
  const k = RAMPS[palette] ?? RAMPS.natural;
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  let j = 0;
  while (j + 8 < k.length && k[j + 4] < x) j += 4;
  const span = k[j + 4] - k[j];
  const f = span > 0 ? (x - k[j]) / span : 0;
  for (let c = 0; c < 3; c++) out[c] = k[j + 1 + c] + (k[j + 5 + c] - k[j + 1 + c]) * f;
  out[3] = Math.max(out[0], out[1], out[2]);
  return out;
}

/** Manifest defaults for the motion params (a test keeps tidalviz.json in step). */
export const MOTION_DEFAULTS = { turbulence: 1, speed: 1, reactivity: 1 };
/** What those defaults become under macOS "Reduce motion": a slower, steadier, gentler fire. */
export const REDUCED_MOTION = { turbulence: 0.45, speed: 0.6, reactivity: 0.55 };

/**
 * Effective turbulence, speed and reactivity. With `reduceMotion`, a param still at its manifest
 * default is swapped for the calmer value; a value the user chose is respected.
 * @param {Record<string, unknown>} params live ctx.params
 * @param {boolean} reduceMotion
 * @param {{ turbulence: number, speed: number, reactivity: number }} out
 */
export function motion(params, reduceMotion, out) {
  const t = Number(params.turbulence);
  const s = Number(params.speed);
  const r = Number(params.reactivity ?? MOTION_DEFAULTS.reactivity);
  out.turbulence = reduceMotion && t === MOTION_DEFAULTS.turbulence ? REDUCED_MOTION.turbulence : t;
  out.speed = reduceMotion && s === MOTION_DEFAULTS.speed ? REDUCED_MOTION.speed : s;
  out.reactivity = reduceMotion && r === MOTION_DEFAULTS.reactivity ? REDUCED_MOTION.reactivity : r;
  return out;
}

const rampTmp = new Float32Array(4);

/**
 * Fill an RGBA8 lookup texture (length = texels × 4) with a palette ramp, texel i at t = i / (n − 1).
 * Called when the palette changes, not per frame.
 * @param {string} palette
 * @param {Uint8Array} lut
 */
export function fillRampLut(palette, lut) {
  const n = lut.length >> 2;
  for (let i = 0; i < n; i++) {
    rampColor(palette, n > 1 ? i / (n - 1) : 0, rampTmp);
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = Math.round(rampTmp[c] * 255);
  }
}
