// @ts-check
/**
 * The cubic structure's runtime (shaders/lattice/structure-cubic.glsl): a rounded cube at every
 * integer node, rods along the three axes, sized by the Rod thickness param.
 */
import { THICKNESS, geometry } from "./lattice.js";

/** Worst-case rod radius and cube corner reach (cells), over every Rod thickness. */
const WORST = geometry(THICKNESS.max, new Float32Array(3));
const ROD = WORST[0];
const CORNER = Math.sqrt(3) * (WORST[1] - WORST[2]) + WORST[2];

/**
 * Free distance at `pos` from the thickest rods and largest cubes.
 * @param {ArrayLike<number>} pos
 */
export function cubicClearance(pos) {
  const fx = pos[0] - Math.round(pos[0]);
  const fy = pos[1] - Math.round(pos[1]);
  const fz = pos[2] - Math.round(pos[2]);
  // Rods along x lie on lines with integer y and z, and so on.
  const rod = Math.min(Math.hypot(fy, fz), Math.hypot(fx, fz), Math.hypot(fx, fy)) - ROD;
  return Math.min(rod, Math.hypot(fx, fy, fz) - CORNER);
}

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function cubicRuntime(ctx) {
  const geo = new Float32Array(3);
  geometry(Number(ctx.params.thickness), geo);
  return {
    onBeat() {},
    step() {},
    upload(gl, u) {
      gl.uniform3f(u.u_geo, geo[0], geo[1], geo[2]);
    },
    params(changed) {
      if ("thickness" in changed) geometry(Number(ctx.params.thickness), geo);
    },
  };
}
