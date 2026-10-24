// @ts-check
/**
 * The Look param and the cinematic look's colour pipeline (shaders/composite.frag mirrors
 * `tonePixel`). Classic is the pack's original additive lines, untouched. Cinematic accumulates
 * the lines as linear light in a float buffer, blooms it (./bloom.js), then exposes, tone maps
 * and encodes it for display:
 *
 * - Tone curve: Krzysztof Narkowicz, "ACES Filmic Tone Mapping Curve" (2016), a least-squares
 *   fit of the ACES RRT + ODT, x(2.51x + 0.03) / (x(2.43x + 0.59) + 0.14). Its derivative's
 *   numerator is 1.408x² + 0.7028x + 0.0042 > 0, so it is strictly increasing for x ≥ 0; it
 *   tends to 2.51 / 2.43 and is clamped to 1. Applied per channel, so very bright overlaps also
 *   drift toward white, like film.
 * - Display encoding: a pure 2.2 power, the inverse of the decode the line shaders apply to the
 *   classic palette (so a lone line keeps about its classic brightness). Not the sRGB curve: its
 *   linear segment near black (slope 12.92), on top of the ACES fit's toe, crushed the Field's
 *   faint lines to a quarter of their classic brightness; through the power curve the toe's
 *   low-end slope is (0.214 · exposure)^(1/2.2) ≈ 0.53, so faint lines stay visible. The price
 *   is that faint veiling glare from the bloom shows too, so the Field blooms less.
 * - Transparency: the canvas stays premultiplied light. Alpha = max(r, g, b) after tone mapping,
 *   as the classic shaders do before blending, so black stays fully transparent and every pixel
 *   composites as light over the desktop.
 */

/** Film grain refresh rate (frames per second), when it isn't held still. */
export const GRAIN_HZ = 24;

/**
 * The cinematic look's constants. Fixed, not params: nothing here reacts to the beat (the beat
 * effects stay local, in the line shaders), so there are no whole-scene pulses.
 */
export const CINEMA = Object.freeze({
  /** Linear exposure before the tone curve. */
  exposure: 1.15,
  /** Bloom's share of the light (energy-conserving lerp, Jimenez 2014); the Field's is smaller. */
  bloom: 0.12,
  fieldBloom: 0.04,
  /** Chromatic aberration at the corners, CSS px (red out, blue in). */
  aberration: 1.2,
  /** Vignette: light lost at the corners. */
  vignette: 0.28,
  /** Film grain amplitude (multiplicative, so empty pixels stay transparent). */
  grain: 0.035,
  /** Line core width, CSS px (Lines soft); Lines fine is one scene pixel. */
  width: 1,
  /**
   * Möbius Field: thinner lines than the single strip, and more gain. Quads keep every sub-pixel
   * segment GL lines drop, but each faint line then passes the ACES toe in linear light, which
   * leaves it at about half its classic brightness; × 2 (in display space, like Brightness) brings
   * the field back to classic's overall level.
   */
  fieldWidth: 0.6,
  fieldGain: 2,
  /** Prefilter (Gaussian) sigma, in target pixels. */
  sigma: 0.5,
  /**
   * Möbius Field depth of field: the blur disk far away, and its cap up close, CSS px. Bands
   * beyond the focus soften toward 6 px; bands nearer than it blur faster (2× at a third of the
   * focal distance), up to 18 px.
   */
  fieldAperture: 6,
  fieldCocMax: 18,
  /** Möbius depth of field (focused on the strip's centre): subtler. */
  mobiusAperture: 3,
  mobiusCocMax: 3,
});

/** @param {unknown} v the `look` select @returns {"classic" | "cinematic"} */
export function lookMode(v) {
  return v === "cinematic" ? "cinematic" : "classic";
}

/** Display gamma: the line shaders decode the classic colours by it, the composite encodes. */
export const GAMMA = 2.2;

/** Narkowicz's ACES fit, clamped to [0, 1]. @param {number} x linear light ≥ 0 */
export function acesFilm(x) {
  const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * One pixel through the composite's curve: exposure, ACES fit, display encode, alpha = max.
 * @param {number} r @param {number} g @param {number} b linear light
 * @param {number} exposure @param {Float32Array | number[]} out [r, g, b, a], display, premultiplied
 */
export function tonePixel(r, g, b, exposure, out) {
  out[0] = acesFilm(r * exposure) ** (1 / GAMMA);
  out[1] = acesFilm(g * exposure) ** (1 / GAMMA);
  out[2] = acesFilm(b * exposure) ** (1 / GAMMA);
  out[3] = Math.max(out[0], out[1], out[2]);
  return out;
}

/**
 * The grain pattern's seed: a new pattern GRAIN_HZ times a second, or one fixed pattern when
 * `still` (Reduce flashing or Reduce motion), so the grain never flickers then.
 * @param {number} t seconds @param {boolean} still
 */
export function grainSeed(t, still) {
  return still ? 0 : Math.floor(t * GRAIN_HZ) % 1000;
}
