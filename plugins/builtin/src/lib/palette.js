// @ts-check
/**
 * Stargate's colour: cosine palettes, colour(t) = a + b·cos(2π(c·t + d)) per channel (Iñigo Quilez).
 * The shader walks t with each row's hue, the lane and slow time, so colours cycle.
 */

/** Palette param options, in manifest order. */
export const PALETTES = ["film", "ember", "ice", "mono"];

/** a (3), b (3), c (3), d (3) per palette. */
const COEFFS = {
  // The Star Gate's saturated film stock: magenta, amber, acid green, electric blue, violet.
  film: [0.5, 0.5, 0.55, 0.5, 0.5, 0.45, 1, 1, 1, 0.0, 0.33, 0.67],
  // Furnace: deep red through orange to gold.
  ember: [0.62, 0.32, 0.12, 0.38, 0.3, 0.12, 1, 1, 1, 0.0, 0.08, 0.2],
  // Cold light: cyan, electric blue, violet.
  ice: [0.32, 0.52, 0.78, 0.3, 0.34, 0.22, 1, 1, 1, 0.55, 0.45, 0.35],
  // White light only.
  mono: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 0, 0, 0],
};

/**
 * Write the named palette's 12 coefficients (a, b, c, d as consecutive vec3s) into `out`; unknown
 * names get "film".
 * @param {unknown} name Palette param value
 * @param {Float32Array} out length ≥ 12
 * @returns {Float32Array} out
 */
export function paletteCoeffs(name, out) {
  const k = COEFFS[/** @type {keyof typeof COEFFS} */ (PALETTES.includes(String(name)) ? name : "film")];
  for (let i = 0; i < 12; i++) out[i] = k[i];
  return out;
}
