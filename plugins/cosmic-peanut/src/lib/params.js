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

/**
 * Where the rings are drawn this frame. Fine lines: straight to the canvas at native DPR.
 * Soft lines: a 1× buffer upscaled to the canvas — multisampled (2× MSAA, ~7.5 MB more GPU
 * memory at 1440p) when the Antialias param is on, plain when it's off.
 * @param {unknown} lines `lines` select ("soft" | "fine")
 * @param {unknown} antialias `antialias` boolean (missing ⇒ on, the manifest default)
 * @returns {"canvas" | "msaa" | "soft"}
 */
export function renderPath(lines, antialias) {
  if (lines === "fine") return "canvas";
  return antialias === false ? "soft" : "msaa";
}
