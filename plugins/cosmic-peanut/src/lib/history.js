// @ts-check
/** Ring history: an M × N circular buffer of rings (PRD "Ring history"). */
import { createRingBuilder } from "./ring.js";
import { createPushScheduler } from "./scheduler.js";

/** Value of a never-written texel. The shader treats rows holding it as invisible. */
export const SENTINEL = 1e6;

/**
 * @callback UploadRow
 * @param {number} row history row just written (the new head)
 * @param {Float32Array} ring M samples, reused: read it during the call
 * @returns {void}
 */

/**
 * @param {number} M points per ring
 * @param {number} N rings alive
 * @param {UploadRow} upload called once per pushed ring (one texSubImage2D row)
 */
export function createHistory(M, N, upload) {
  const builder = createRingBuilder(M);
  const clock = createPushScheduler();
  const h = {
    M,
    N,
    /** Row of the newest ring. */
    head: 0,
    /** M × N texels (row-major, one ring per row), for the initial texture upload. */
    data: new Float32Array(M * N).fill(SENTINEL),
    /** Leftover fraction of a push interval, 0–1 (the shader's `uFrac`). */
    get frac() {
      return clock.frac;
    },
    /**
     * Push the rings due after `dt` seconds, building each from `wave` and uploading its row.
     * Trigger search, resampling and gain run only here, once per pushed ring.
     * @param {ArrayLike<number>} wave newest waveform
     * @param {number} dt seconds
     * @param {number} travel seconds pole to pole
     * @param {number} detail 0–1
     * @returns {number} rings pushed
     */
    step(wave, dt, travel, detail) {
      const n = clock.step(dt, h.N / travel);
      for (let k = 0; k < n; k++) {
        h.head = (h.head + 1) % h.N;
        upload(h.head, builder.build(wave, detail));
      }
      return n;
    },
    /**
     * Change the number of rings. Reallocates `data` filled with the sentinel and restarts the
     * history, so the old rings vanish instead of flashing as flat circles.
     * @param {number} n rings
     * @returns {boolean} whether anything changed (the texture must then be reallocated)
     */
    setDensity(n) {
      if (n === h.N) return false;
      h.N = n;
      h.head = 0;
      h.data = new Float32Array(M * n).fill(SENTINEL);
      clock.reset();
      return true;
    },
  };
  return h;
}
