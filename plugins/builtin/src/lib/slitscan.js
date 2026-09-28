// @ts-check
/**
 * Stargate's slit-scan history: the waveform, one row at a time.
 */

/**
 * Resample `span` samples of `wave` from `start` into every texel of `out`, by linear
 * interpolation between the two nearest samples (no averaging: each texel is one point of the
 * waveform). The first and last texels are exactly the span's first and last samples.
 * @param {ArrayLike<number>} wave
 * @param {number} start first sample
 * @param {number} span samples (≥ 2), `start + span <= wave.length`
 * @param {Float32Array} out W texels
 * @returns {Float32Array} out
 */
export function resampleRow(wave, start, span, out) {
  const W = out.length;
  const step = (span - 1) / (W - 1);
  const last = start + span - 1;
  for (let i = 0; i < W; i++) {
    const x = start + i * step;
    const i0 = Math.min(Math.floor(x), last);
    const i1 = Math.min(i0 + 1, last);
    out[i] = wave[i0] + (wave[i1] - wave[i0]) * (x - i0);
  }
  return out;
}

/**
 * Oscilloscope trigger: index of the first rising zero crossing (`wave[i-1] <= 0 < wave[i]`) in
 * `[1, end)`, or 0 if there is none. Starting each row there keeps a steady tone's lanes in place
 * from row to row, so they read as long streaks instead of noise.
 * @param {ArrayLike<number>} wave
 * @param {number} end exclusive search limit
 */
export function findTrigger(wave, end) {
  const n = Math.min(end, wave.length);
  for (let i = 1; i < n; i++) if (wave[i - 1] <= 0 && wave[i] > 0) return i;
  return 0;
}

/**
 * Per-row colour features from `audio.bands`: `hue` is the level-weighted centroid of the band
 * index (0 = lowest band, 1 = highest; 0.5 in silence), `energy` the mean band level (0–1).
 * @param {ArrayLike<number>} bands
 * @param {{ hue: number, energy: number }} out
 */
export function bandFeatures(bands, out) {
  const n = bands.length;
  let sum = 0;
  let moment = 0;
  for (let i = 0; i < n; i++) {
    sum += bands[i];
    moment += bands[i] * i;
  }
  out.energy = sum / n;
  out.hue = sum > 1e-9 ? moment / sum / (n - 1) : 0.5;
  return out;
}

/** Rows below this peak level are not boosted further (keeps silence and hiss dark). */
export const GAIN_FLOOR = 0.08;
/** Per-row release of the level tracker (≈ a few seconds at typical row rates). */
const LEVEL_RELEASE = 0.994;
/** Per-row decay of the streak (peak-hold) channel. */
export const STREAK_DECAY = 0.93;

/**
 * Builds one history row: W RGBA texels.
 *   R  signed waveform (auto-gained so quiet music still fills −1..1)
 *   G  streak: peak-hold of |R| that decays by STREAK_DECAY per row, so a bright lane leaves a
 *      tail behind it in depth (the slit-scan smear)
 *   B  hue from the bands (same for the whole row)
 *   A  energy from the bands (same for the whole row)
 * The waveform span is its first half, starting at the first rising zero crossing in the first half
 * (any length ≥ 4 works). Nothing is allocated per build.
 * @param {number} W texels per row
 */
export function createRowBuilder(W) {
  const tmp = new Float32Array(W);
  const streak = new Float32Array(W);
  const feat = { hue: 0.5, energy: 0 };
  let level = 0;
  return {
    /**
     * @param {ArrayLike<number>} wave newest waveform
     * @param {ArrayLike<number>} bands `audio.bands`
     * @param {Float32Array} out W × 4 floats
     */
    build(wave, bands, out) {
      const n = wave.length;
      const span = Math.max(2, n >> 1);
      resampleRow(wave, findTrigger(wave, n - span + 1), span, tmp);
      let peak = 0;
      for (let i = 0; i < W; i++) peak = Math.max(peak, Math.abs(tmp[i]));
      level = Math.max(peak, level * LEVEL_RELEASE);
      const gain = 1 / Math.max(level, GAIN_FLOOR);
      bandFeatures(bands, feat);
      for (let i = 0, o = 0; i < W; i++, o += 4) {
        const v = tmp[i] * gain;
        streak[i] = Math.max(Math.abs(v), streak[i] * STREAK_DECAY);
        out[o] = v;
        out[o + 1] = streak[i];
        out[o + 2] = feat.hue;
        out[o + 3] = feat.energy;
      }
      return out;
    },
  };
}
