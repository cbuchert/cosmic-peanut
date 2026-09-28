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
 *   so with `reduceFlashing` it rises at most 3 times per second.
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
     */
    step(audio, dt, reduceFlashing) {
      hit *= Math.exp(-dt / 0.25);
      if (audio.onset) {
        const h = 0.5 + 0.5 * Math.min(1, audio.onsetStrength);
        if (h > hit) hit = h;
      }
      const bass = Number.isFinite(audio.bass) ? audio.bass : 1;
      const s = (bass - 0.7) / 1.3;
      this.stoke = stokeEnv.step(s < 0 ? 0 : s > 1 ? 1 : s, dt);
      this.flare = flareEnv.step(hit, dt);
      this.boost = limiter.step(0.5 * this.stoke + this.flare, dt, reduceFlashing);
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
