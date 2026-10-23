// @ts-check
/**
 * Lattice's cube-face history: an N-row ring of W RGBA8 texels, one row pushed per frame (one
 * texSubImage2D of `row` at row `head`). The cube faces scroll through it, so each face shows the
 * recent spectrum as a scrolling spectrogram. The row buffer is preallocated; `push` allocates
 * nothing.
 */

/** @param {number} W texels per row @param {number} N rows in the ring */
export function createFaceHistory(W, N) {
  const h = {
    W,
    N,
    /** Ring row holding the newest row. */
    head: 0,
    /** The newest row, W × RGBA bytes (reused). */
    row: new Uint8Array(W * 4),
    /**
     * Build the next row and advance the ring.
     * @param {Float32Array} bands @param {Float32Array} waveform @param {number} gain
     * @returns {number} the ring row to upload `row` to
     */
    push(bands, waveform, gain) {
      const row = h.row;
      const nb = bands.length;
      const nw = waveform.length;
      const g = Math.max(0, gain);
      for (let i = 0; i < W; i++) {
        // Red: the mean of this column's bands, × gain.
        const b0 = Math.floor((i * nb) / W);
        const b1 = Math.max(b0 + 1, Math.floor(((i + 1) * nb) / W));
        let e = 0;
        for (let k = b0; k < b1; k++) e += bands[k];
        const level = (g * e) / (b1 - b0);
        // Green: the signed sample of largest magnitude in this column's stretch of the waveform.
        const w0 = Math.floor((i * nw) / W);
        const w1 = Math.floor(((i + 1) * nw) / W);
        let v = 0;
        for (let k = w0; k < w1; k++) if (Math.abs(waveform[k]) > Math.abs(v)) v = waveform[k];
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        row[i * 4] = Math.round(255 * (level > 1 ? 1 : level));
        row[i * 4 + 1] = Math.round(127.5 + 127.5 * v);
        row[i * 4 + 2] = 0;
        row[i * 4 + 3] = 255;
      }
      h.head = (h.head + 1) % N;
      return h.head;
    },
  };
  return h;
}
