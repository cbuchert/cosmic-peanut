// @ts-check
/**
 * Waveform → ring: trigger, point-sample, auto-gain, seam taper (PRD "Turning a waveform into a
 * ring"). Runs only when a ring is pushed, and never allocates after construction.
 */

/**
 * Samples one ring spans: 1024 at Detail 0 (smooth) down to 192 at Detail 1 (jagged).
 * @param {number} detail 0–1
 */
export function windowLength(detail) {
  return Math.round(1024 - 832 * detail);
}

/**
 * Oscilloscope trigger: index of the first rising zero crossing that still leaves a full window
 * after it, so consecutive rings line up. 0 when there is no crossing, or when fewer than 2W
 * samples are available (a short waveform is used as it is).
 * @param {ArrayLike<number>} wave
 * @param {number} W window length
 */
export function findTrigger(wave, W) {
  if (wave.length < 2 * W) return 0;
  for (let i = 1; i < wave.length - W; i++) {
    if (wave[i - 1] < 0 && wave[i] >= 0) return i;
  }
  return 0;
}

/**
 * Point-sample W samples from `start` into `out.length` points with linear interpolation. No
 * averaging or filtering: that would lose the jaggedness. Returns the absolute peak written.
 * @param {ArrayLike<number>} wave
 * @param {number} start first sample
 * @param {number} W window length (start + W ≤ wave.length)
 * @param {Float32Array} out
 */
export function resample(wave, start, W, out) {
  const M = out.length;
  const step = W / M;
  const last = wave.length - 1;
  let peak = 0;
  for (let j = 0; j < M; j++) {
    const x = start + j * step;
    const i0 = Math.floor(x);
    const i1 = i0 < last ? i0 + 1 : last;
    const f = x - i0;
    const s = wave[i0] * (1 - f) + wave[i1] * f;
    out[j] = s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  return peak;
}

/** Per-ring decay of the tracked peak (slow: a few seconds at typical push rates). */
export const PEAK_DECAY = 0.992;
/** Tracked-peak floor, so silence isn't amplified into noise. */
export const PEAK_FLOOR = 0.02;
/** Normalized samples are clamped to ± this. */
export const RING_CLAMP = 1.5;

/**
 * Auto-gain peak tracker: follow a louder ring at once, otherwise decay slowly.
 * @param {number} track previous tracked peak
 * @param {number} peak this ring's absolute peak
 */
export function nextPeak(track, peak) {
  const decayed = track * PEAK_DECAY;
  return peak > decayed ? peak : decayed;
}

/** Fraction of the ring at each end that eases to zero so the ring closes without a seam. */
export const TAPER = 0.08;

/**
 * Normalize a resampled ring in place: divide by the tracked peak (floored), taper the first and
 * last {@link TAPER} of points to zero with a raised cosine, and clamp.
 * @param {Float32Array} ring
 * @param {number} track tracked peak from {@link nextPeak}
 */
export function finishRing(ring, track) {
  const M = ring.length;
  const T = Math.floor(M * TAPER);
  const norm = 1 / (track > PEAK_FLOOR ? track : PEAK_FLOOR);
  for (let j = 0; j < M; j++) {
    let w = 1;
    if (j < T) w = 0.5 - 0.5 * Math.cos((Math.PI * j) / T);
    else if (j > M - 1 - T) w = 0.5 - 0.5 * Math.cos((Math.PI * (M - 1 - j)) / T);
    const v = ring[j] * norm * w;
    ring[j] = v > RING_CLAMP ? RING_CLAMP : v < -RING_CLAMP ? -RING_CLAMP : v;
  }
}

/**
 * Reusable waveform → ring converter with its own auto-gain state. `build` writes into and returns
 * the same `ring` array every time.
 * @param {number} M points per ring
 */
export function createRingBuilder(M) {
  const ring = new Float32Array(M);
  let track = 0.1;
  return {
    ring,
    /**
     * @param {ArrayLike<number>} wave newest samples (any length ≥ 2)
     * @param {number} detail 0–1
     */
    build(wave, detail) {
      const want = windowLength(detail);
      const W = want < wave.length ? want : wave.length - 1;
      const i = findTrigger(wave, W);
      // Sub-sample crossing point, so the rings don't jitter by up to one sample.
      const a = i > 0 ? wave[i - 1] : 0;
      const start = i > 0 ? i - 1 + a / (a - wave[i]) : 0;
      track = nextPeak(track, resample(wave, start, W, ring));
      finishRing(ring, track);
      return ring;
    },
  };
}
