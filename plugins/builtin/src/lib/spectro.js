// @ts-check
/**
 * Blaze's spectrogram feed: pure, allocation-free helpers that turn the host's linear-magnitude
 * spectrum into per-column levels on a log-frequency fuel line. GPU side: shaders/blaze/.
 */

/**
 * Frequency edges (Hz) of each fuel-line column on a log axis from fMin to fMax. Texel i sits at
 * x = (i + 0.5) / lo.length.
 * - "linear": low → high, left → right; the columns tile fMin–fMax with equal log widths.
 * - "mirrored": the lowest band at the two centre columns, the highest at both edges; each half
 *   tiles fMin–fMax on its own, so the line is symmetric.
 * @param {string} layout "mirrored" | "linear"
 * @param {number} fMin Hz
 * @param {number} fMax Hz
 * @param {Float32Array} lo out: lower edge per column
 * @param {Float32Array} hi out: upper edge per column
 */
export function logColumns(layout, fMin, fMax, lo, hi) {
  const S = lo.length;
  const mirrored = layout !== "linear";
  const n = mirrored ? S >> 1 : S; // distinct columns
  const ratio = fMax / fMin;
  for (let i = 0; i < S; i++) {
    let k = i;
    if (mirrored) k = i < n ? n - 1 - i : i - n;
    lo[i] = fMin * ratio ** (k / n);
    hi[i] = fMin * ratio ** ((k + 1) / n);
  }
}

/** Sample rate assumed when a frame doesn't carry a usable one. */
const DEFAULT_RATE = 48000;

/**
 * Resample a linear-magnitude spectrum (bin k at k · sampleRate / (2 · spec.length) Hz; any
 * length) into columns with the given frequency edges. A column that covers at least one bin
 * centre takes the loudest of them, so a narrow partial is never averaged away; a column narrower
 * than a bin (the bass end) interpolates linearly between the two bins around its centre, so the
 * low end is smooth instead of stepped. Beyond Nyquist reads 0.
 * @param {ArrayLike<number>} spec
 * @param {number} sampleRate Hz
 * @param {Float32Array} lo column lower edges, Hz
 * @param {Float32Array} hi column upper edges, Hz
 * @param {Float32Array} out magnitude per column
 */
export function resampleSpectrum(spec, sampleRate, lo, hi, out) {
  const len = spec.length;
  const sr = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : DEFAULT_RATE;
  const inv = len > 0 ? (2 * len) / sr : 0; // bins per Hz
  const last = len - 1;
  for (let i = 0; i < out.length; i++) {
    const a = lo[i] * inv;
    const b = hi[i] * inv;
    const k0 = Math.ceil(a);
    const bb = Math.floor(b);
    const k1 = bb < last ? bb : last;
    let v = 0;
    if (k1 >= k0) {
      for (let k = k0; k <= k1; k++) if (spec[k] > v) v = spec[k];
    } else if (a < last) {
      const c = 0.5 * (a + b);
      const i0 = Math.floor(c);
      const f = c - i0;
      v = spec[i0] + (spec[i0 + 1] - spec[i0]) * f;
    }
    out[i] = v;
  }
}

/**
 * Magnitude → display level (0–1) in dB, per column:
 *   dB = 20·log10(mag) + tilt (+3 dB/octave around 1 kHz, so pink music reads level; see setTilt)
 *   Anything under `floorDb` (the gate) is 0.
 *   Each column tracks its own peak dB (instant attack, falling `releaseDb` dB/s) and the
 *   loudest column's peak is the mix's reference. A column's reference sits `own` of the way from
 *   the mix's toward its own peak, so a quiet register gets some lift without being flattened to
 *   the loudest one: two sustained tones 20 dB apart still read clearly different.
 *   level = (dB − base) / (ref − base), base = max(floorDb, ref − rangeDb), clamped 0–1.
 * A quieter mix (same shape) normalises to the same levels once the peaks settle.
 * @param {number} count columns
 * @param {{ floorDb?: number, rangeDb?: number, own?: number, releaseDb?: number }} [opts]
 */
export function createSpectroGain(count, { floorDb = -66, rangeDb = 24, own = 0.35, releaseDb = 3 } = {}) {
  const env = new Float32Array(count).fill(floorDb);
  const db = new Float32Array(count);
  const tilt = new Float32Array(count);
  return {
    /**
     * Pink tilt per column from its frequency edges: +3 dB per octave above 1 kHz, −3 below.
     * @param {Float32Array} lo Hz
     * @param {Float32Array} hi Hz
     */
    setTilt(lo, hi) {
      for (let i = 0; i < count; i++) tilt[i] = 1.5 * Math.log2((lo[i] * hi[i]) / 1e6);
    },
    /**
     * @param {ArrayLike<number>} mags linear magnitude per column
     * @param {number} dt seconds
     * @param {Float32Array} out level per column, 0–1
     */
    step(mags, dt, out) {
      const fall = releaseDb * dt;
      let top = floorDb;
      for (let i = 0; i < count; i++) {
        const m = mags[i];
        const d = m > 1e-9 ? 20 * Math.log10(m) + tilt[i] : -180;
        db[i] = d;
        const e = env[i] - fall;
        const pk = d > e ? d : e > floorDb ? e : floorDb;
        env[i] = pk;
        if (pk > top) top = pk;
      }
      for (let i = 0; i < count; i++) {
        const d = db[i];
        if (d <= floorDb) {
          out[i] = 0;
          continue;
        }
        const ref = top - own * (top - env[i]);
        const lowest = ref - rangeDb;
        const base = lowest > floorDb ? lowest : floorDb;
        const x = (d - base) / (ref - base);
        out[i] = x > 0 ? (x < 1 ? x : 1) : 0;
      }
    },
    reset() {
      env.fill(floorDb);
    },
  };
}

/** Upward speed (screen heights per sim second) a silent column's gas is held to: a smoulder. */
export const RISE_MIN = 0.04;
/** … and a full-level column's: it races to the top in well under a second. */
export const RISE_MAX = 2.4;
/** Extra expansion exponent per unit of reactivity. */
const RISE_EXPAND = 1;

/**
 * Flame speed as a function of a column's level: the upward speed the sim drives that column's gas
 * toward, in screen heights per sim second (the Speed param scales sim time, so on screen it's
 * this × Speed):
 *   speed = RISE_MIN + (RISE_MAX − RISE_MIN) · level^γ,  γ = 1 + reactivity
 * Reactivity (0–2, clamped) is the contrast: 0 is linear in level; higher holds quiet columns back
 * harder while a full-level column still reaches RISE_MAX.
 * @param {number} level 0–1 (clamped)
 * @param {number} reactivity 0–2
 */
export function riseSpeed(level, reactivity) {
  const l = level > 0 ? (level < 1 ? level : 1) : 0; // NaN → 0
  const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
  return RISE_MIN + (RISE_MAX - RISE_MIN) * l ** (1 + RISE_EXPAND * r);
}
