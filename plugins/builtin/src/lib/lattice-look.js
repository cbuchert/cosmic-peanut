// @ts-check
/**
 * The Lattice family's Look param and the cinematic look's pure, tested pieces (shaders/lattice/
 * README.md → "Shading"): the tone curve the composite applies (post.frag mirrors it), the
 * composite's alpha rule, and per-Quality sample counts. Nothing here allocates per frame.
 *
 * - classic: the original shading (shade.glsl and post.frag with CINEMATIC undefined), byte for
 *   byte.
 * - cinematic: physically based shading (GGX + Burley, split-sum environment, thin film, tube
 *   lights for the beat pulses, analytic fog in-scatter, soft shadows), a bloom chain and a filmic
 *   tone curve.
 */

/** Look options, in manifest order. */
export const LOOKS = ["classic", "cinematic"];
/** Manifest default of the Look param. */
export const DEFAULT_LOOK = "classic";

/** @param {unknown} name the Look param → "classic" | "cinematic" (unknown → DEFAULT_LOOK) */
export function lookOf(name) {
  return LOOKS.includes(String(name)) ? String(name) : DEFAULT_LOOK;
}

/**
 * Extra `#define`s for the scene and composite shaders. Classic adds none, so its shader text is
 * exactly the original. @param {unknown} name the Look param
 */
export function lookDefines(name) {
  return lookOf(name) === "cinematic" ? ["CINEMATIC"] : [];
}

/**
 * Exposure before the tone curve (post.frag TONE_EXPOSURE). The scene is lit in HDR linear units in
 * which the palettes' surfaces under the key light sit near 0.5.
 */
export const EXPOSURE = 0.8;
/** Narkowicz's fit of the ACES RRT + ODT (2015): x (a x + b) / (x (c x + d) + e). */
const A = 2.51;
const B = 0.03;
const C = 2.43;
const D = 0.59;
const E = 0.14;

/**
 * The cinematic tone curve (post.frag `tone`, per channel): Narkowicz's ACES filmic fit after
 * EXPOSURE, clamped to 1. A toe under the identity in the darks, a shoulder toward white, strictly
 * rising until it reaches 1. @param {number} x HDR linear (≥ 0) → display linear 0–1
 */
export function tone(x) {
  const v = Math.max(0, x) * EXPOSURE;
  return Math.min(1, (v * (A * v + B)) / (v * (C * v + D) + E));
}

/**
 * The tone curve's inverse: the HDR value that `tone` maps to `y` (the solution of a quadratic).
 * Used for display-referred colours (the fog background, ink) so that they come out exactly.
 * y ≥ 1 → where the curve reaches 1. @param {number} y display linear
 */
export function toneInverse(y) {
  const t = Math.max(0, Math.min(1, y));
  // (C t − A) v² + (D t − B) v + E t = 0, with C t − A < 0: the one root ≥ 0.
  const a = C * t - A;
  const b = D * t - B;
  const v = (-b - Math.sqrt(b * b - 4 * a * E * t)) / (2 * a);
  return v / EXPOSURE;
}

/**
 * The composite's alpha (post.frag): the canvas is premultiplied over the shell's backdrop, so
 * light drawn on black keeps alpha = its brightest channel (it adds over the desktop), and what a
 * surface covers keeps at least its coverage (classic's fog transmittance; 1 with Background
 * "fog"). @param {number} r @param {number} g @param {number} b display colour after tone mapping,
 * premultiplied @param {number} coverage 0–1
 */
export function compositeAlpha(r, g, b, coverage) {
  return Math.min(1, Math.max(coverage, r, g, b));
}

/** Key-light soft-shadow taps and AO taps per Quality (cinematic; shade.glsl SHADOW_CAP, AO_CAP). */
const SAMPLES = {
  low: { shadow: 8, ao: 3 },
  medium: { shadow: 12, ao: 4 },
  high: { shadow: 20, ao: 6 },
};
/** @param {unknown} quality the Quality param → its sample counts (unknown → medium) */
export function shadingSamples(quality) {
  const q = String(quality);
  return q === "low" || q === "high" ? SAMPLES[q] : SAMPLES.medium;
}

/** Floats paletteMaterial writes: f0 (linear RGB), roughness (perceptual), metalness. */
export const MATERIAL_FLOATS = 5;
/**
 * Per palette, the lattice's material for the cinematic look (f0 is reflectance at normal
 * incidence, linear; metals take their colour from it, dielectrics reflect 0.04 = IOR 1.5).
 * Measured f0: iron (0.56, 0.57, 0.58) and brass (0.91, 0.78, 0.42) (Hoffman, "Physics and Math
 * of Shading", SIGGRAPH 2015 course; brass between its copper and gold entries).
 * @type {Record<string, number[]>}
 */
const MATERIALS = {
  // Steel, lightly blued (the palette's cool surface): a metal, satin.
  steel: [0.53, 0.57, 0.62, 0.34, 1],
  // Brass: a warm metal, a little rougher (worn).
  brass: [0.91, 0.78, 0.42, 0.4, 1],
  // Ink on paper: a matte black dielectric (its albedo is the palette's surface colour).
  ink: [0.04, 0.04, 0.04, 0.55, 0],
};

/**
 * Write a palette's material into `out` (f0 r, g, b, roughness, metalness). Unknown → steel.
 * @param {unknown} name the Palette param @param {Float32Array} out length ≥ MATERIAL_FLOATS
 */
export function paletteMaterial(name, out) {
  const m = Object.hasOwn(MATERIALS, String(name)) ? MATERIALS[String(name)] : MATERIALS.steel;
  for (let i = 0; i < MATERIAL_FLOATS; i++) out[i] = m[i];
  return out;
}
