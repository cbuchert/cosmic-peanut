// @ts-check
/**
 * Pure, allocation-free helpers for Blaze (the waveform-seeded fire). Everything here runs on the
 * CPU once per frame (or once per param change) and is unit-tested; the GPU side lives in
 * shaders/blaze/.
 */

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
