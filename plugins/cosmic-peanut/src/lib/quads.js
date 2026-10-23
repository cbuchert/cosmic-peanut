// @ts-check
/**
 * Prefiltered lines for the cinematic look, after Eric Chan and Frédo Durand, "Fast Prefiltered
 * Lines", GPU Gems 2, ch. 22 (2005). A line is drawn as a screen-space quad a little wider than
 * the line plus its filter. The vertex shader gives each corner its signed distance from the
 * centre line in pixels, the rasterizer interpolates it (their edge-function distance), and the
 * fragment shader turns that distance into coverage: the line's box profile convolved with a
 * radially symmetric filter, which depends only on the distance. They read it from a table for a
 * cone filter; here the filter is a Gaussian, whose 1D profile against a box has the closed form
 * in {@link coverage}, so the shader evaluates it directly. Widening the filter to a defocus
 * blur (./dof.js) keeps the profile's integral at the line width: wider and proportionally
 * dimmer, the energy conserved.
 *
 * Each polyline (a ring or a slice) becomes one triangle strip with two vertices per point, one
 * either side, offset along the screen-space normal of the point's neighbours (shaders/quad.glsl).
 * Shared vertices mean no gaps or doubled overlaps at the joints.
 */
import { RESTART } from "./geometry.js";

/** Quad half extent beyond the core, in sigmas: past it the coverage is under 1%. */
export const EXTENT_SIGMAS = 2.5;

/**
 * Vertex attribute (2j + side, i) for both sides of every point j = 0…P−1 of every polyline
 * i = 0…N−1, and TRIANGLE_STRIP indices zig-zagging across each line, with a primitive restart
 * between lines. Built once per density, like ./geometry.js `buildGrid`.
 * @param {number} N lines @param {number} P points per line
 */
export function buildQuadGrid(N, P) {
  const verts = new Uint16Array(N * P * 2 * 2);
  const indices = new Uint32Array(N * (2 * P + 1));
  let v = 0;
  let k = 0;
  for (let i = 0; i < N; i++) {
    const base = i * P * 2;
    for (let j = 0; j < P; j++) {
      for (let side = 0; side < 2; side++) {
        verts[v++] = 2 * j + side;
        verts[v++] = i;
        indices[k++] = base + 2 * j + side;
      }
    }
    indices[k++] = RESTART;
  }
  return { verts, indices };
}

/**
 * The error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7); shaders/quad.glsl has
 * the same polynomial.
 * @param {number} x
 */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - y * Math.exp(-a * a));
}

/**
 * Coverage at distance d from the centre of a line of half width h, prefiltered with a Gaussian
 * of standard deviation s: ½(erf((h + d)/(s√2)) + erf((h − d)/(s√2))). Integrates to 2h over d.
 * @param {number} d @param {number} h @param {number} s all in pixels
 */
export function coverage(d, h, s) {
  const k = Math.SQRT1_2 / s;
  return 0.5 * (erf((h + d) * k) + erf((h - d) * k));
}

/** How far each side of the centre line the quad reaches. @param {number} h @param {number} s */
export function quadExtent(h, s) {
  return h + EXTENT_SIGMAS * s;
}
