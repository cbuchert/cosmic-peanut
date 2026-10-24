// @ts-check
/**
 * The kaleidoscope structure's runtime and camera (shaders/lattice/structure-kaleidoscope.glsl;
 * the pure logic is lib/kaleido.js).
 *
 * Camera: the cubic channel camera (lib/lattice-camera.js) scaled by PERIOD, so it flies the
 * naves carved along the cell edges — with all of its smoothness, and its turns decided on the
 * beat — and never comes within NAVE − PERIOD/6 of where the fractal may be.
 */
import { createCamera } from "./lattice-camera.js";
import { motionScale } from "./lattice.js";
import { PERIOD, createKaleidoMusic } from "./kaleido.js";

/** World cells per second at a fly speed of 1 (the naves are PERIOD cells apart). */
const SPEED = 1.6;
/** How far a passing pulse front bends the fold offsets (a fraction of them). */
const RIPPLE = 0.07;

/**
 * The cubic camera, scaled up to the naves.
 * @param {number} seed
 * @returns {ReturnType<typeof createCamera>}
 */
export function createKaleidoCamera(seed) {
  const inner = createCamera(seed);
  const pos = new Float64Array(3);
  const sync = () => {
    for (let c = 0; c < 3; c++) pos[c] = inner.pos[c] * PERIOD;
  };
  sync();
  return {
    get beatTurns() {
      return inner.beatTurns;
    },
    get idleTurns() {
      return inner.idleTurns;
    },
    get lookYaw() {
      return inner.lookYaw;
    },
    get lookPitch() {
      return inner.lookPitch;
    },
    view: inner.view,
    fwd: inner.fwd,
    up: inner.up,
    right: inner.right,
    pos,
    beat() {
      inner.beat();
    },
    /** The path point `dist` cells ahead, into `out`. */
    ahead(/** @type {number} */ dist, /** @type {Float64Array} */ out) {
      inner.ahead(dist / PERIOD, out);
      for (let c = 0; c < 3; c++) out[c] *= PERIOD;
      return out;
    },
    pointer(/** @type {import('../../tidalviz').PointerInput} */ e) {
      inner.pointer(e);
    },
    update(/** @type {number} */ dt, /** @type {number} */ speed) {
      inner.update(dt, (speed * SPEED) / PERIOD);
      sync();
    },
  };
}

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function kaleidoRuntime(ctx) {
  const music = createKaleidoMusic();
  const rot = new Float32Array(9);
  return {
    onBeat() {},
    step(audio, dt, f) {
      music.step(audio.bands, dt, f.react, ctx.reduceMotion, f.live);
    },
    upload(gl, u, f) {
      // Column-major for GLSL.
      const r = music.rot;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rot[j * 3 + i] = r[i * 3 + j];
      gl.uniformMatrix3fv(u.u_kRot, false, rot);
      gl.uniform4f(u.u_kOS, music.offset[0], music.offset[1], music.offset[2], music.scale);
      gl.uniform1f(u.u_kRipple, RIPPLE * motionScale(ctx.reduceMotion));
      const o = f.origin;
      const m = (/** @type {number} */ x) => x - PERIOD * Math.floor(x / PERIOD);
      gl.uniform3f(u.u_kOrg, m(o[0]), m(o[1]), m(o[2]));
    },
    params() {},
  };
}
