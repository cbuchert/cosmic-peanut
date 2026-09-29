// @ts-check
/**
 * The Tetraballs blob as a signed distance field, mirrored from shaders/tetraballs/common.glsl so
 * the fusing behaviour and the bounds are tested here. Four spheres joined by a polynomial
 * smooth minimum (Quilez): within k of each other two surfaces melt into a liquid bridge; further
 * apart they're separate droplets.
 */

/**
 * Quadratic smooth minimum. ≤ min(a, b); equal to it once |a − b| ≥ k; k = 0 is a hard union.
 * @param {number} a
 * @param {number} b
 * @param {number} k blend width
 */
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Signed distance from (x, y, z) to the blob of four balls.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Float32Array} centers 4 × xyz
 * @param {Float32Array} radii 4
 * @param {number} k blend width
 */
export function blobSdf(x, y, z, centers, radii, k) {
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = Math.hypot(x - centers[i * 3], y - centers[i * 3 + 1], z - centers[i * 3 + 2]) - radii[i];
    d = i === 0 ? s : smin(d, s, k);
  }
  return d;
}

/**
 * Centre distance below which two balls of radius r are joined by a bridge (the blend reaches the
 * midpoint): at the midpoint both distances are D/2 − r, and smin(a, a, k) = a − k/4.
 * @param {number} r
 * @param {number} k
 */
export function bridgeDistance(r, k) {
  return 2 * r + k / 2;
}

/**
 * Radius of a sphere about the centroid that contains the whole blob when every ball sits at most
 * `maxDist` from the centroid with radius at most `maxR`. The smooth minimum can push the surface
 * out by up to k/4 where two balls blend, hence the margin. The raymarch is clipped to it.
 * @param {number} maxDist
 * @param {number} maxR
 * @param {number} k
 */
export function boundRadius(maxDist, maxR, k) {
  return maxDist + maxR + k * 0.25;
}
