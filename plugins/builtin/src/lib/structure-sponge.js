// @ts-check
/**
 * The sponge structure (shaders/lattice/structure-sponge.glsl, Lattice's "sponge"): a Menger
 * sponge flown as an endless self-similar zoom.
 *
 * The world. Frame units ("cells") put the camera's home cube M at [0, 9]³: its central tunnels
 * are 3 wide, its sub-cubes 3, their tunnels 1, and so on down. M is the edge-middle sub-cube
 * (1, 0, 1) of its parent, which is the same sub-cube of its own parent, and so on up: the cubes
 * nest about the zoom centre F = (9, 4.5, 9), the fixed point of S(p) = F + (p − F) / 3, which
 * maps each cube onto the next smaller one. Space is folded across the two faces through F
 * (x = 9, z = 9), so the world is the same in all four quadrants about F's edge. Under S it is
 * exactly self-similar: S maps the world onto itself.
 *
 * The rebase. The camera (lib/sponge-camera.js) flies from M's central tunnel into a tunnel one
 * third the size; when it has passed into it, every position is mapped by S⁻¹ (×3 about F) and
 * the zoom depth goes up by one. Since the world is invariant under S, the view is unchanged,
 * and positions stay within a few cells of F however deep the flight goes (float32 is enough).
 *
 * What is rendered: the cube K = 2 levels above M (81 cells, its walls ≥ 40 cells from F, beyond
 * the march limit), carved level by level. Each level's carving is a Lipschitz-1 bound (IQ's
 * Menger cross), so the march takes full steps. The shader stops carving where a level's holes
 * shrink under a pixel (fading them in over the pixel before), and where the point is already far
 * from the level's features (a coarser bound is still a bound) — both scale with the zoom, so a
 * rebase changes nothing.
 */
import { PULSE_CAP as PULSE_SLOTS } from "./lattice-pulses.js";

/** The zoom centre, frame cells. */
export const SPONGE_F = [9, 4.5, 9];
/** Centre and half-size of the rendered (coarsest) cube. */
export const SPONGE_C = [-31.5, 4.5, -31.5];
export const SPONGE_H = 40.5;
/** Levels the clearance carves (down to holes 1/27 cell wide): fewer levels = more solid. */
const CLEAR_LEVELS = 7;
/** Clearance margin: the march's hit tolerance and then some. */
const MARGIN = 0.02;

/**
 * Distance bound (cells) from frame point `p` to the sponge, carved to `levels` levels (level 0:
 * holes 27 wide, 2: M's 3-wide tunnels, 3: 1 wide, …). Mirrors sceneSDF in structure-sponge.glsl.
 * @param {ArrayLike<number>} p @param {number} [levels]
 */
export function spongeDistance(p, levels = CLEAR_LEVELS) {
  let x = p[0];
  const y = p[1];
  let z = p[2];
  if (x > SPONGE_F[0]) x = 2 * SPONGE_F[0] - x;
  if (z > SPONGE_F[2]) z = 2 * SPONGE_F[2] - z;
  const qx = (x - SPONGE_C[0]) / SPONGE_H;
  const qy = (y - SPONGE_C[1]) / SPONGE_H;
  const qz = (z - SPONGE_C[2]) / SPONGE_H;
  const bx = Math.abs(qx) - 1;
  const by = Math.abs(qy) - 1;
  const bz = Math.abs(qz) - 1;
  let d =
    Math.hypot(Math.max(bx, 0), Math.max(by, 0), Math.max(bz, 0)) + Math.min(Math.max(bx, by, bz), 0);
  let s = 1;
  for (let m = 0; m < levels; m++) {
    const rx = cross(qx, s);
    const ry = cross(qy, s);
    const rz = cross(qz, s);
    s *= 3;
    // The median of the three: inside a hole when two coordinates sit in their middle third.
    const r2 = Math.max(Math.min(rx, ry), Math.min(Math.max(rx, ry), rz));
    d = Math.max(d, (r2 - 1) / s);
  }
  return d * SPONGE_H;
}

/** IQ's Menger cross coordinate: ≥ 1 in the middle third of a cell at scale `s`. */
function cross(/** @type {number} */ q, /** @type {number} */ s) {
  const v = q * s;
  const a = v - 2 * Math.floor(v / 2) - 1;
  return Math.abs(1 - 3 * Math.abs(a));
}

/**
 * Map a frame point `k` rebases on (k = 1: into the next, smaller frame — ×3 about F; k = −1:
 * back), into `out`.
 * @param {ArrayLike<number>} p @param {number} k @param {Float64Array | number[]} out
 */
export function rebasePoint(p, k, out) {
  const f = 3 ** k;
  for (let c = 0; c < 3; c++) out[c] = SPONGE_F[c] + (p[c] - SPONGE_F[c]) * f;
  return out;
}

/**
 * Free distance at a camera position: the distance bound with fewer levels carved (more solid,
 * so a lower bound on any rendering), less a margin.
 * @param {ArrayLike<number>} pos
 */
export function spongeClearance(pos) {
  return spongeDistance(pos) - MARGIN;
}

/** @typedef {{ depth?: number, scale?: number }} ZoomCamera the zoom state a camera may expose */

/**
 * Beat pulses through the zoom. The shared pool (lib/lattice-pulses.js) keeps each pulse's source
 * in the frame it was launched in and its front in local cells; this carries both into the
 * current frame (S⁻¹ once per rebase since launch), then into the shader's local cells: positions
 * as (p − F) / scale, the front ÷ scale (see spongeRuntime).
 */
export function createPulseRebase() {
  const n = PULSE_SLOTS;
  const launchDepth = new Float64Array(n);
  const launchScale = new Float64Array(n).fill(1);
  const prevFront = new Float64Array(n).fill(Infinity);
  return {
    /** Per pulse: source in the shader's local cells about F (x, y, z) and front, for u_pulse. */
    data: new Float32Array(n * 4),
    /**
     * Note launches (a front that went back) after the pool has stepped.
     * @param {{ data: Float32Array }} pulses @param {ZoomCamera} cam
     */
    step(pulses, cam) {
      for (let i = 0; i < n; i++) {
        const front = pulses.data[i * 4 + 3];
        if (front < prevFront[i]) {
          launchDepth[i] = cam.depth ?? 0;
          launchScale[i] = cam.scale ?? 1;
        }
        prevFront[i] = front;
      }
    },
    /**
     * Write `data` for the current frame.
     * @param {{ data: Float32Array }} pulses @param {ArrayLike<number>} origin @param {ZoomCamera} cam
     */
    update(pulses, origin, cam) {
      const depth = cam.depth ?? 0;
      const scale = cam.scale ?? 1;
      for (let i = 0; i < n; i++) {
        const f = 3 ** (depth - launchDepth[i]);
        for (let c = 0; c < 3; c++) {
          const p = pulses.data[i * 4 + c] + origin[c];
          this.data[i * 4 + c] = ((p - SPONGE_F[c]) * f) / scale;
        }
        this.data[i * 4 + 3] = (pulses.data[i * 4 + 3] * launchScale[i] * f) / scale;
      }
    },
  };
}

/** The sponge's pulse topology: a pulse starts right on the camera's path ahead. */
export function pathPoint(/** @type {ArrayLike<number>} */ point, /** @type {Float64Array} */ out) {
  for (let c = 0; c < 3; c++) out[c] = point[c];
  return out;
}

/**
 * The sponge's runtime: the shader works in local cells about F (structure-sponge.glsl), so this
 * re-uploads the camera and the pulses that way, and the scale.
 * @param {import('../../tidalviz').VisualizerContext} _ctx
 * @returns {import('./structures.js').StructureRuntime}
 */
export function spongeRuntime(_ctx) {
  const fix = createPulseRebase();
  return {
    onBeat() {},
    step(_audio, _dt, f) {
      fix.step(f.pulses, f.cam);
    },
    upload(gl, u, f) {
      const cam = f.cam;
      const s = cam.scale ?? 1;
      gl.uniform1f(u.u_zs, s);
      gl.uniform3f(u.u_cam, (cam.pos[0] - SPONGE_F[0]) / s, (cam.pos[1] - SPONGE_F[1]) / s, (cam.pos[2] - SPONGE_F[2]) / s);
      fix.update(f.pulses, f.origin, cam);
      gl.uniform4fv(u.u_pulse, fix.data);
    },
    params() {},
  };
}
