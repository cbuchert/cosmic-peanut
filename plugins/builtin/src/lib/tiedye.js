// @ts-check
/** Tie-Dye's pure logic. */

/** Most colors a palette may have (uniform array sizes in the shader). */
export const MAX_COLORS = 8;
/** Seconds for the band widths to follow the mix. */
const WIDTH_TAU = 0.35;
/** Extra width per unit of region energy (a silent region keeps width 1). */
const WIDTH_GAIN = 3;

export function createBandWidths() {
  const w = new Float32Array(MAX_COLORS);
  const energy = new Float32Array(MAX_COLORS);
  return {
    /**
     * @param {Float32Array} bands
     * @param {number} n
     * @param {number} dt
     * @param {number} reactivity
     */
    step(bands, n, dt, reactivity) {
      w.fill(0);
      const a = 1 - Math.exp(-dt / WIDTH_TAU);
      let total = 0;
      for (let k = 0; k < n; k++) {
        const lo = Math.floor((k * bands.length) / n);
        const hi = Math.floor(((k + 1) * bands.length) / n);
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        energy[k] += (e / Math.max(1, hi - lo) - energy[k]) * a;
        w[k] = 1 + WIDTH_GAIN * reactivity * energy[k];
        total += w[k];
      }
      for (let k = 0; k < n; k++) w[k] /= total;
      return w;
    },
  };
}
