// @ts-check
/**
 * Stargate's slit-scan history: an N-row ring of W RGBA float texels, one row per push.
 *
 * Rows are pushed at a fixed rate driven by a `dt` accumulator (not once per display frame), so the
 * flow is the same at 60 and 120 Hz. `frac` (0–1) is the leftover fraction of a push interval: the
 * shader adds it to every row's age, so rows glide between pushes instead of stepping.
 */

/**
 * @param {number} W texels per row
 * @param {number} N rows in the ring
 * @param {(row: number, data: Float32Array) => void} upload called once per pushed row (one
 *   texSubImage2D), with the ring row just written and its W × 4 floats (reused buffer)
 */
export function createSlitHistory(W, N, upload) {
  const row = new Float32Array(W * 4);
  const h = {
    W,
    N,
    /** Ring row holding the newest row. */
    head: 0,
    /** Leftover fraction of a push interval, 0–1. */
    frac: 0,
    /**
     * Advance by `dt`; build and upload every row that fell due.
     * @param {number} dt seconds
     * @param {number} rate rows per second
     * @param {(row: Float32Array) => void} build fills W × 4 floats
     * @returns {number} rows pushed
     */
    step(dt, rate, build) {
      const clock = h.frac + Math.max(0, dt * rate);
      const n = Math.floor(clock);
      h.frac = clock - n;
      // Rows beyond the ring's length would be overwritten in this same step: skip them.
      const skip = Math.max(0, n - h.N);
      h.head = (h.head + skip) % h.N;
      for (let k = skip; k < n; k++) {
        h.head = (h.head + 1) % h.N;
        build(row);
        upload(h.head, row);
      }
      return n;
    },
    /**
     * Change the number of rows. Restarts the ring (the texture must then be reallocated).
     * @param {number} n rows
     * @returns {boolean} whether anything changed
     */
    resize(n) {
      if (n === h.N) return false;
      h.N = n;
      h.head = 0;
      h.frac = 0;
      return true;
    },
  };
  return h;
}

/**
 * Texture v coordinate (0–1) of the row `age` rows older than the head (fractional ages fall
 * between rows, for linear filtering). The shader computes the same thing:
 * `fract((head - age + 0.5) / N)`.
 * @param {number} head ring row of the newest row
 * @param {number} age rows since the newest (≥ 0, fractional)
 * @param {number} N rows in the ring
 */
export function texRow(head, age, N) {
  const v = (head - age + 0.5) / N;
  return v - Math.floor(v);
}
