// @ts-check
/**
 * The tentacle structure's runtime (shaders/lattice/structure-tentacle.glsl, Tentacle Lattice):
 * a Tentacube-style creature at every node — sway, the local bass swell, the quarter-turn twist
 * at each beat pulse's node, and the material sequencer (shade.glsl's MATERIALS). The pure logic
 * is lib/tentacle-lattice.js.
 */
import { motionScale } from "./lattice.js";
import {
  LENGTH,
  SWAY_MAX,
  SWELL_MAX,
  createMaterials,
  createSwell,
  createSway,
  createTwists,
  envelopeMax,
  motionParams,
  tentacleGeometry,
} from "./tentacle-lattice.js";

/** Seed of the twists' axis picks (Lattice's path seed). */
const SEED = 0x1a77;
/** Worst-case tentacle extent from its strut's axis and swollen cube reach (cells). */
const WORST_GEO = tentacleGeometry(LENGTH.max);
const ENVELOPE = envelopeMax(WORST_GEO, SWAY_MAX);
const CORNER = Math.sqrt(3) * WORST_GEO.half * (1 + SWELL_MAX);

/**
 * Free distance at `pos` from the longest, widest-swaying tentacles and the most swollen cubes.
 * @param {ArrayLike<number>} pos
 */
export function tentacleClearance(pos) {
  const fx = pos[0] - Math.round(pos[0]);
  const fy = pos[1] - Math.round(pos[1]);
  const fz = pos[2] - Math.round(pos[2]);
  const strut = Math.min(Math.hypot(fy, fz), Math.hypot(fx, fz), Math.hypot(fx, fy)) - ENVELOPE;
  return Math.min(strut, Math.hypot(fx, fy, fz) - CORNER);
}

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function tentacleRuntime(ctx) {
  const sway = createSway();
  const swell = createSwell();
  const twists = createTwists(SEED);
  const materials = createMaterials();
  const motion = { sway: 1, twitch: 1 };
  let tg = tentacleGeometry(Number(ctx.params.length));
  /** @type {Float32Array} */
  let weights = new Float32Array(4);
  return {
    onBeat(source) {
      twists.kick(source, motionParams(ctx.params, ctx.reduceMotion, motion).twitch, ctx.reduceMotion);
    },
    step(audio, dt, f) {
      motionParams(ctx.params, ctx.reduceMotion, motion);
      sway.step(audio.bands, dt, motion.sway, f.react, ctx.reduceMotion);
      swell.step(f.live ? audio.bassAtt : 1, dt, f.react, ctx.reduceMotion);
      twists.step(dt, f.origin);
      weights = materials.step(dt, ctx.params.material, f.live ? audio.rms : 0, f.bpm);
    },
    upload(gl, u, f) {
      const g = tg;
      const w = weights;
      gl.uniform4f(u.u_tg, g.reach, g.root, g.tip, g.half);
      gl.uniform3f(u.u_sway, sway.amp, sway.clock, sway.ripple);
      // Bound on how far any tentacle surface gets from its strut's axis.
      gl.uniform1f(u.u_env, envelopeMax(g, sway.amp));
      gl.uniform1f(u.u_swell, swell.value);
      gl.uniform4fv(u.u_twist, twists.data);
      gl.uniform1fv(u.u_taxis, twists.axis);
      gl.uniform4f(u.u_mat, w[0], w[1], w[2], w[3]);
      gl.uniform3f(u.u_origin, f.origin[0], f.origin[1], f.origin[2]);
      gl.uniform1f(u.u_shake, motionScale(ctx.reduceMotion));
      gl.uniform4fv(u.u_live, f.pulses.live);
      gl.uniform1fv(u.u_liveAmp, f.pulses.liveAmp);
      gl.uniform1i(u.u_np, f.pulses.liveCount);
    },
    params(changed) {
      if ("length" in changed) tg = tentacleGeometry(Number(ctx.params.length));
    },
  };
}
