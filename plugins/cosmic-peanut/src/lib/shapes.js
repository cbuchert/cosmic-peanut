// @ts-check
/**
 * The pack's visualizers share everything but the vertex shader that places the rings and how
 * the scene is framed. Picked once by `ctx.id`. The sphere has a fixed extent; Möbius rides a
 * track (./track.js, ./snake.js) and is framed by it (camera.js `fitTrack`).
 */
import { RADIUS } from "./camera.js";

/**
 * @typedef {object} Shape
 * @property {string} vert vertex shader asset
 * @property {string} quadVert the cinematic look's vertex shader (prefiltered line quads)
 * @property {boolean} track whether the rings ride a Möbius track (snake, Track and Length params)
 * @property {(width: number) => number} extent the sphere's reach from the center (camera fit
 *   and depth fade); tracks use their own bounds instead
 */

/** @type {Record<string, Shape>} */
const SHAPES = {
  "cosmic-peanut": { vert: "shaders/rings.vert", quadVert: "shaders/quad-rings.vert", track: false, extent: () => RADIUS },
  mobius: { vert: "shaders/mobius.vert", quadVert: "shaders/quad-mobius.vert", track: true, extent: () => NaN },
};

/** @param {string} id manifest visualizer id (`ctx.id`) */
export function shapeFor(id) {
  const shape = SHAPES[id];
  if (!shape) throw new Error(`cosmic-peanut: no shape for visualizer "${id}"`);
  return shape;
}
