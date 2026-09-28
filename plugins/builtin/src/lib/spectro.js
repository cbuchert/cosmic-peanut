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
