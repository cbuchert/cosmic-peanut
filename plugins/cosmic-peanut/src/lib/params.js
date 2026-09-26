// @ts-check
/** Manifest param values → numbers the renderer uses. */

/**
 * Rings alive at once for the `density` select.
 * @param {unknown} v
 */
export function densityRings(v) {
  return v === "sparse" ? 120 : v === "dense" ? 400 : 240;
}

/**
 * Shader palette index for the `palette` select.
 * @param {unknown} v
 */
export function paletteIndex(v) {
  return v === "ember" ? 1 : v === "phosphor" ? 2 : 0;
}

/**
 * Overall line gain: Brightness × 0.55 × √(240 ÷ N), so density changes don't change total
 * brightness; × 1.35 in Fine lines mode to make up for thinner (native-DPR) lines.
 * @param {number} bright Brightness param
 * @param {number} N rings alive
 * @param {boolean} fine Fine lines mode
 */
export function ringGain(bright, N, fine) {
  return bright * 0.55 * Math.sqrt(240 / N) * (fine ? 1.35 : 1);
}
