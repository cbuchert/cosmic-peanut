// @ts-check
/**
 * Stargate's view geometry, mirrored from shaders/stargate/stargate.frag so it can be tested.
 *
 * The camera sits between two infinite planes y = +h and y = −h and looks down +z. A screen point
 * (x, y) — y up, in units of half the screen height, origin at the centre — is the ray direction
 * (x, y, 1) (a 90° vertical field of view). It meets the plane on its side at depth z = h / |y|,
 * where the lateral coordinate is u = x · z. The horizon (z → ∞) is the line y = 0, turned by the
 * roll.
 */

/**
 * @param {number} sx screen x (half-heights from centre)
 * @param {number} sy screen y (half-heights from centre, up)
 * @param {number} roll camera roll, radians
 * @param {number} h plane distance from the eye
 * @param {{ z: number, u: number, side: number }} out z depth, u lateral, side +1 upper / −1 lower
 */
export function planeHit(sx, sy, roll, h, out) {
  // Rolling the camera by `roll` turns the image counter-clockwise by `roll`: undo that turn on the
  // screen point to get the ray in the camera's frame. Ray casting after the turn keeps the
  // perspective exact however far it has rolled.
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  const x = c * sx + s * sy;
  const y = c * sy - s * sx;
  const ay = Math.abs(y);
  out.z = ay > 0 ? h / ay : Infinity;
  out.u = x * out.z;
  out.side = y >= 0 ? 1 : -1;
  return out;
}

/**
 * History row age (0 = newest, fractional) shown at depth `z`. Rows enter at the far depth `zFar`
 * (the most recent music glows at the horizon) and each push moves every row one `rowDepth` toward
 * the viewer; `frac`, the push clock's leftover fraction, makes that glide continuous.
 * @param {number} z depth
 * @param {number} zFar depth where the newest row enters
 * @param {number} rowDepth depth spanned by one row
 * @param {number} frac leftover fraction of a push interval, 0–1
 */
export function rowAge(z, zFar, rowDepth, frac) {
  return (zFar - z) / rowDepth - frac;
}
