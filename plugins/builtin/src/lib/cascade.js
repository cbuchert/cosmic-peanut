// @ts-check
/**
 * Cascade — pure logic behind the waterfall (tested in cascade.test.js; the shaders mirror it).
 */

/**
 * |wave| resampled to `out.length` texels by point sampling with linear interpolation between the
 * two nearest samples — no box filter, so the waveform's jaggedness survives. Works for any input
 * length (read `.length`; 0 → all zero).
 * @param {ArrayLike<number>} wave
 * @param {Float32Array} out
 */
export function resampleAbs(wave, out) {
  const n = wave.length;
  const m = out.length;
  if (n === 0) return out.fill(0);
  const step = m > 1 ? (n - 1) / (m - 1) : 0;
  for (let i = 0; i < m; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = i0 + 1 < n ? i0 + 1 : i0;
    const f = x - i0;
    const a = Math.abs(wave[i0]);
    out[i] = a + (Math.abs(wave[i1]) - a) * f;
  }
  return out;
}

/** Seed smoothing time constant (s): a few frames, so ropes persist long enough to read as water. */
export const SEED_TAU = 0.035;

/** Auto-gain release time constant (s) and the level below which gain stops rising. */
export const GAIN_RELEASE = 4;
export const GAIN_FLOOR = 0.1;

/** Peak of the silence trickle, as a fraction of full flow. */
export const TRICKLE = 0.06;

/**
 * The flow floor: a few thin, slowly wandering streams, so silence is a trickle rather than a
 * dry, frozen lip.
 * @param {number} x 0–1 across the lip
 * @param {number} t seconds
 */
export function trickle(x, t) {
  const b = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (3 * x + 0.05 * t) + 1.3 * Math.sin(0.4 * t + 2 * x));
  const b2 = b * b;
  return TRICKLE * (0.08 + 0.92 * b2 * b2 * b2);
}

/**
 * The 1D flow seed across the lip, rebuilt once per frame from the newest waveform (allocates
 * nothing after creation).
 * @param {number} texels
 */
export function createSeed(texels) {
  const raw = new Float32Array(texels);
  const smooth = new Float32Array(texels);
  const values = new Float32Array(texels);
  let level = 0;
  let clock = 0;
  return {
    /** Mean of `values`: the total flow over the lip. */
    mean: 0,
    /** |waveform| resampled and smoothed over time, before gain. */
    smooth,
    /** The seed the GPU reads: flow strength per texel across the lip. */
    values,
    /** @param {ArrayLike<number>} wave @param {number} dt @param {number} surge */
    update(wave, dt, surge) {
      resampleAbs(wave, raw);
      const a = 1 - Math.exp(-dt / SEED_TAU);
      let top = 0;
      for (let i = 0; i < texels; i++) {
        smooth[i] += (raw[i] - smooth[i]) * a;
        if (smooth[i] > top) top = smooth[i];
      }
      // Auto-gain: instant attack, slow release, and a gain ceiling so real quiet stays thin.
      level = top > level ? top : level + (top - level) * (1 - Math.exp(-dt / GAIN_RELEASE));
      const gain = 1 / Math.max(level, GAIN_FLOOR);
      clock += dt;
      let sum = 0;
      for (let i = 0; i < texels; i++) {
        const tr = trickle(i / (texels - 1), clock);
        values[i] = tr + (1 - tr) * Math.min(1, smooth[i] * gain) * surge;
        sum += values[i];
      }
      this.mean = sum / texels;
    },
  };
}

/**
 * Inverse CDF of the seed, for sampling respawn positions across the lip. The seed is a piecewise
 * constant density (texel i covers [i/N, (i+1)/N)); `out[j]` is the lip position x in [0, 1] where
 * the cumulative flow reaches j / (M - 1). Built on the CPU once per frame (O(N + M)), so the
 * respawn shader draws x with one uniform random number and two texel fetches — cheaper than
 * rejection sampling, which would loop per particle. An all-zero seed gives a uniform lip.
 * @param {Float32Array} seed
 * @param {Float32Array} out
 */
export function buildInverseCdf(seed, out) {
  const n = seed.length;
  const m = out.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += seed[i] > 0 ? seed[i] : 0;
  if (!(total > 0)) {
    for (let j = 0; j < m; j++) out[j] = j / (m - 1);
    return out;
  }
  let i = 0;
  let before = 0; // cumulative flow before texel i
  for (let j = 0; j < m; j++) {
    const target = (j / (m - 1)) * total;
    let v = seed[i] > 0 ? seed[i] : 0;
    while (i < n - 1 && before + v < target) {
      before += v;
      i++;
      v = seed[i] > 0 ? seed[i] : 0;
    }
    const f = v > 0 ? Math.min(1, Math.max(0, (target - before) / v)) : 1;
    out[j] = (i + f) / n;
  }
  return out;
}

/**
 * Draw a lip position from `buildInverseCdf`'s table: linear interpolation between the two nearest
 * entries. The respawn shader does exactly this with two texelFetch calls.
 * @param {Float32Array} inv
 * @param {number} u uniform in [0, 1)
 */
export function sampleInverse(inv, u) {
  const p = u * (inv.length - 1);
  const j = Math.floor(p);
  const k = j + 1 < inv.length ? j + 1 : j;
  return inv[j] + (inv[k] - inv[j]) * (p - j);
}
