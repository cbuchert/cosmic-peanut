// @ts-check
/**
 * Depth of field for the cinematic look: the cheap line-based bokeh. Each line vertex gets a
 * circle of confusion from its depth (the thin-lens model; Potmesil & Chakravarty, "A Lens and
 * Aperture Camera Model for Synthetic Image Generation", SIGGRAPH 1981: diameter
 * A·f/(z_f − f)·|z − z_f|/z, which for f ≪ z_f is A′·|1 − z_f/z|). The line's prefilter
 * (./quads.js) is widened by the blur disk, so out-of-focus lines get wider and proportionally
 * dimmer: the coverage profile still integrates to the line width. The focus distance eases
 * toward its target with a critically damped spring (no jumps, no overshoot), and holds still
 * under Reduce motion: no focus pulling.
 */

/** The focus spring's rate (1/s): critically damped, settled (99%) in about 2.7 s. */
export const FOCUS_RATE = 2.5;

/**
 * Blur disk diameter (pixels) at view depth z, focused at `focus`.
 * @param {number} z view depth (> 0) @param {number} focus focal distance
 * @param {number} aperture diameter far away, pixels (0: no depth of field) @param {number} max cap
 */
export function circleOfConfusion(z, focus, aperture, max) {
  if (aperture <= 0) return 0;
  const c = aperture * Math.abs(1 - focus / Math.max(z, 1e-6));
  return c < max ? c : max;
}

/**
 * The line's filter sigma with a blur disk of diameter `coc` added: a uniform disk of radius R has
 * variance R²/4 per axis, so (coc/4)², summed with the prefilter's (convolved Gaussians add).
 * @param {number} sigma prefilter sigma @param {number} coc blur disk diameter, same units
 */
export function defocusSigma(sigma, coc) {
  return Math.sqrt(sigma * sigma + (coc * coc) / 16);
}

/** The focus distance, eased. @param {number} start initial (and Reduce motion) focal distance */
export function createFocus(start) {
  let v = 0;
  const focus = {
    distance: start,
    /**
     * Ease toward `target`; exact for any dt (the same as fly.js's look-around spring).
     * @param {number} target @param {number} dt seconds @param {boolean} hold Reduce motion: stay put
     */
    step(target, dt, hold) {
      if (hold) {
        v = 0;
        return focus.distance;
      }
      const x = focus.distance - target;
      const b = v + FOCUS_RATE * x;
      const e = Math.exp(-FOCUS_RATE * dt);
      focus.distance = target + (x + b * dt) * e;
      v = (b - FOCUS_RATE * (x + b * dt)) * e;
      return focus.distance;
    },
  };
  return focus;
}
