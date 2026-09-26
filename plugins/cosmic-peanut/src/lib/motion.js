// @ts-check
/** Reduced motion (PRD "Camera and motion"). */

/** What Orbit speed and Bass pulse default to when the host reports reduced motion. */
export const GENTLE = Object.freeze({ orbit: 0, pulse: 0.1 });

/**
 * Effective value of a motion param: while reduced motion is on and the user hasn't moved the
 * param off its manifest default, use the gentle value instead. Users can still raise it.
 * @param {number} value current param value
 * @param {number} manifestDefault the param's manifest default
 * @param {boolean} reduce ctx.reduceMotion
 * @param {number} gentleValue
 */
export function gentle(value, manifestDefault, reduce, gentleValue) {
  return reduce && value === manifestDefault ? gentleValue : value;
}
