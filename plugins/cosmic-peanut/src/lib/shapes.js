// @ts-check
/**
 * The pack's visualizers share everything but the vertex shader that places the rings and the
 * scene's extent (camera fit and depth fade radius). Picked once by `ctx.id`.
 */
import { RADIUS } from "./camera.js";

/** Möbius strip centerline radius (R). */
export const MOBIUS_RADIUS = 1;

/**
 * @typedef {object} Shape
 * @property {string} vert vertex shader asset
 * @property {(width: number) => number} extent distance from the center to the farthest point of
 *   the undisplaced shape, given the `width` param (half width W; the sphere ignores it)
 */

/** @type {Record<string, Shape>} */
const SHAPES = {
  "cosmic-peanut": { vert: "shaders/rings.vert", extent: () => RADIUS },
  mobius: { vert: "shaders/mobius.vert", extent: (width) => MOBIUS_RADIUS + width },
};

/** @param {string} id manifest visualizer id (`ctx.id`) */
export function shapeFor(id) {
  const shape = SHAPES[id];
  if (!shape) throw new Error(`cosmic-peanut: no shape for visualizer "${id}"`);
  return shape;
}
