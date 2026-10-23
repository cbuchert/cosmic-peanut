// @ts-check
/**
 * The TPMS structures' table pieces and runtime (shaders/lattice/structure-tpms.glsl, one define
 * per surface): the gyroid, Schwarz P and Schwarz D sheets of lib/tpms.js, the net camera through
 * one labyrinth (lib/net-camera.js), pulses launched from the nearest wall, and the music's bend
 * (bass thickens the walls, the mids shift the level), uploaded as u_tpms / u_tphase.
 */
import { createNetCamera } from "./net-camera.js";
import { TPMS, createMorph, sheet, tpmsClearance, wallPoint } from "./tpms.js";

/**
 * A TPMS structure's camera, pulse topology, clearance and runtime, for its STRUCTURES entry.
 * @param {keyof typeof TPMS} name
 */
export function tpmsStructure(name) {
  const s = TPMS[name];
  return {
    camera: (/** @type {number} */ seed) => createNetCamera(s, seed),
    pulseSource: wallPoint(s),
    clearance: tpmsClearance(s),
    runtime: (/** @type {import('../../tidalviz').VisualizerContext} */ ctx) => tpmsRuntime(s, ctx),
  };
}

/**
 * @param {import('./tpms.js').Surface} s
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
function tpmsRuntime(s, ctx) {
  const morph = createMorph();
  const u4 = new Float32Array(4);
  const k = (2 * Math.PI) / s.period;
  /** The origin modulo the period, in radians (the shader's positions are relative to it). */
  const phase = (/** @type {number} */ o) => (((o % s.period) + s.period) % s.period) * k;
  return {
    onBeat() {},
    step(audio, dt, f) {
      morph.step(audio, dt, f.react, f.live, ctx.reduceMotion);
    },
    upload(gl, u, f) {
      sheet(s, Number(ctx.params.thickness), morph.swell, morph.offset, u4);
      gl.uniform4f(u.u_tpms, u4[0], u4[1], u4[2], u4[3]);
      gl.uniform3f(u.u_tphase, phase(f.origin[0]), phase(f.origin[1]), phase(f.origin[2]));
    },
    params() {},
  };
}
