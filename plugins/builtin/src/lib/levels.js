// @ts-check
/** Level-meter math shared by the built-ins. Every function writes in place; none allocate. */

/** Seconds a peak cap stays put before it starts to fall. */
export const PEAK_HOLD = 0.45;
/** Peak-cap fall acceleration, full heights per second². */
const PEAK_GRAVITY = 3.2;

/**
 * Fold the 64 host bands into `count` bars, taking the loudest band in each group so narrow
 * transients still show at low bar counts.
 * @param {ArrayLike<number>} bands 64 values
 * @param {number} count 1–64, a divisor of 64
 * @param {Float32Array} out receives `count` values
 */
export function groupBands(bands, count, out) {
  const per = bands.length / count;
  for (let i = 0; i < count; i++) {
    let m = 0;
    for (let j = i * per, end = j + per; j < end; j++) if (bands[j] > m) m = bands[j];
    out[i] = m;
  }
}

/**
 * Fast attack, exponential release. `smoothing` is the fraction kept per 60 Hz frame on the way
 * down (0 = none), scaled by `dt` so the look doesn't depend on the display rate.
 * @param {Float32Array} levels state, updated in place
 * @param {ArrayLike<number>} target
 * @param {number} count
 * @param {number} smoothing 0–<1
 * @param {number} dt seconds
 */
export function smoothLevels(levels, target, count, smoothing, dt) {
  const keep = smoothing > 0 ? smoothing ** (dt * 60) : 0;
  for (let i = 0; i < count; i++) {
    const t = target[i];
    const fallen = levels[i] * keep + t * (1 - keep);
    levels[i] = t > fallen ? t : fallen;
  }
}

/**
 * Peak caps: jump to any new high, hold for {@link PEAK_HOLD}, then fall with gravity, never
 * below the current level.
 * @param {Float32Array} peaks state
 * @param {Float32Array} hold state: seconds of hold left
 * @param {Float32Array} vel state: fall speed
 * @param {ArrayLike<number>} levels
 * @param {number} count
 * @param {number} dt seconds
 */
export function updatePeaks(peaks, hold, vel, levels, count, dt) {
  for (let i = 0; i < count; i++) {
    const l = levels[i];
    if (l >= peaks[i]) {
      peaks[i] = l;
      hold[i] = PEAK_HOLD;
      vel[i] = 0;
    } else if (hold[i] > 0) {
      hold[i] -= dt;
    } else {
      vel[i] += PEAK_GRAVITY * dt;
      const p = peaks[i] - vel[i] * dt;
      peaks[i] = p > l ? p : l;
    }
  }
}
