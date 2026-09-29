// @ts-check
/**
 * Marbling's pure logic, mirrored by shaders/marbling/sim.frag: the mathematical-marbling maps
 * (Jaffer et al.) and their exact inverses, the per-frame pour scheduler, palettes, renew, resize.
 *
 * Coordinates are "page units": y from 0 (bottom) to 1 (top), x from 0 to the aspect ratio.
 */

/**
 * A drop of radius √r2 landing at (cx, cy): every existing point p moves to
 * c + (p − c)·√(1 + r²/|p − c|²), so |p' − c|² = |p − c|² + r² (area is conserved outside it).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r2 squared radius
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out [x, y]
 */
export function dropForward(cx, cy, r2, px, py, out) {
  const dx = px - cx;
  const dy = py - cy;
  const q = dx * dx + dy * dy;
  const s = q > 0 ? Math.sqrt(1 + r2 / q) : 1;
  out[0] = cx + dx * s;
  out[1] = cy + dy * s;
  return out;
}

/**
 * Exact inverse of {@link dropForward}: where the paint now at p was before the drop. Points
 * inside the drop (|p − c|² < r²) have no pre-image — they hold the drop's own paint — so the
 * function returns true and writes c; otherwise it writes c + (p − c)·√(1 − r²/|p − c|²).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r2 squared radius
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out [x, y]
 * @returns {boolean} p lies inside the drop
 */
export function dropInverse(cx, cy, r2, px, py, out) {
  const dx = px - cx;
  const dy = py - cy;
  const q = dx * dx + dy * dy;
  if (q < r2) {
    out[0] = cx;
    out[1] = cy;
    return true;
  }
  const s = q > 0 ? Math.sqrt(1 - r2 / q) : 0;
  out[0] = cx + dx * s;
  out[1] = cy + dy * s;
  return false;
}

/**
 * Largest contraction factor |v|·max|∇φ| a stylus step may have, so {@link dragInverse}'s
 * fixed-point iteration converges fast (error × 0.25 per step); DRAG_ITERS steps reach < 1e-4.
 */
export const DRAG_CONTRACTION = 0.25;
export const DRAG_ITERS = 7;

/**
 * One step of the stylus (a rake tine) moving by v from s: paint near it is dragged along,
 * p' = p + v·exp(−|p − s|²·invS2), a Gaussian falloff of width 1/√invS2.
 * @param {number} sx
 * @param {number} sy
 * @param {number} vx
 * @param {number} vy
 * @param {number} invS2 1 / σ²
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out
 */
export function dragForward(sx, sy, vx, vy, invS2, px, py, out) {
  const dx = px - sx;
  const dy = py - sy;
  const f = Math.exp(-(dx * dx + dy * dy) * invS2);
  out[0] = px + vx * f;
  out[1] = py + vy * f;
  return out;
}

/**
 * Inverse of {@link dragForward} by fixed-point iteration p ← p' − v·φ(p) (a contraction once v
 * is clamped by {@link clampDrag}). Mirrored in sim.frag.
 * @param {number} sx
 * @param {number} sy
 * @param {number} vx
 * @param {number} vy
 * @param {number} invS2
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out
 */
export function dragInverse(sx, sy, vx, vy, invS2, px, py, out) {
  let x = px;
  let y = py;
  for (let i = 0; i < DRAG_ITERS; i++) {
    const dx = x - sx;
    const dy = y - sy;
    const f = Math.exp(-(dx * dx + dy * dy) * invS2);
    x = px - vx * f;
    y = py - vy * f;
  }
  out[0] = x;
  out[1] = y;
  return out;
}

/**
 * Shorten a stylus step v (in place) so the drag stays invertible: |∇φ| peaks at √(2·invS2/e).
 * @param {number} invS2
 * @param {Float64Array | Float32Array | number[]} v [vx, vy]
 */
export function clampDrag(invS2, v) {
  const lim = DRAG_CONTRACTION / Math.sqrt((2 * invS2) / Math.E);
  const len = Math.hypot(v[0], v[1]);
  if (len > lim) {
    v[0] *= lim / len;
    v[1] *= lim / len;
  }
  return v;
}
