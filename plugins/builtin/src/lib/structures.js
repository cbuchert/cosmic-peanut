// @ts-check
/**
 * The Lattice structure seam: every structure the Lattice family can fly through is one entry
 * here, one GLSL file (shaders/lattice/structure-<name>.glsl, the scene SDF and its surface
 * parameterization) and one JS module (its runtime: per-frame state and uniforms). The rest — the
 * sphere tracer (march.glsl), shading (shade.glsl), the composite (post.frag), the music, the
 * history texture and the pulses — is shared. shaders/lattice/README.md is the contract.
 *
 * An entry:
 * - `shader`: the structure's GLSL file, spliced into lattice.frag at `// #include structure`.
 * - `defines`: extra `#define`s for the whole program (e.g. MATERIALS turns on shade.glsl's
 *   material crossfade).
 * - `camera(seed)`: the camera path provider (pos, view basis, update, ahead, pointer; see
 *   lib/lattice-camera.js for the shape).
 * - `pulseSource(point, out)`: the pulse topology — where a beat pulse launched near `point`
 *   starts (for strut lattices, the nearest node); handed to createPulses. The shader measures how far a front has
 *   travelled with the structure's own `pulseMetric`.
 * - `clearance(pos)`: free distance (cells) at a camera position against the structure's
 *   worst-case geometry over all its params; the tests fly `camera` and require > NEAR_CLEARANCE.
 * - `scale`, `steps`, `fog`, `far`: multipliers on Quality's render scale and march budget, on the
 *   fog density, and the march's distance cap (cells).
 * - `runtime(ctx)`: per-frame state and uniforms (see StructureRuntime).
 */
import { createCamera } from "./lattice-camera.js";
import { nearestNode } from "./lattice-pulses.js";
import { cubicClearance, cubicRuntime } from "./structure-cubic.js";
import { tentacleClearance, tentacleRuntime } from "./structure-tentacle.js";
import * as bitruncated from "./structure-bitruncated.js";
import * as diamond from "./structure-diamond.js";
import * as octet from "./structure-octet.js";

/**
 * What a structure's runtime sees each frame.
 * @typedef {object} StructureFrame
 * @property {number} react the Reactivity param, 0–2
 * @property {boolean} live the audio isn't silent
 * @property {number} bpm the beat tempo used this frame (0 = none)
 * @property {Float64Array} origin the integer origin all shader positions are relative to
 * @property {ReturnType<typeof import('./lattice-pulses.js').createPulses>} pulses
 */

/**
 * A structure's per-frame hooks. `onBeat` runs when a beat pulse launches (after it is
 * launched), `step` once per frame after the pulses have stepped, `upload` with the scene
 * program bound, `params` on param changes. None may allocate per frame.
 * @typedef {object} StructureRuntime
 * @property {(source: Float64Array) => void} onBeat
 * @property {(audio: import('../../tidalviz').AudioFrame, dt: number, f: StructureFrame) => void} step
 * @property {(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, f: StructureFrame) => void} upload
 * @property {(changed: import('../../tidalviz').ParamValues) => void} params
 */

/**
 * @typedef {object} Structure
 * @property {string} shader
 * @property {string[]} defines
 * @property {(seed: number) => ReturnType<typeof createCamera>} camera
 * @property {(point: ArrayLike<number>, out: Float64Array) => Float64Array} pulseSource
 * @property {(pos: ArrayLike<number>) => number} clearance
 * @property {number} scale
 * @property {number} steps
 * @property {number} fog
 * @property {number} far
 * @property {(ctx: import('../../tidalviz').VisualizerContext) => StructureRuntime} runtime
 */

/** Least clearance (cells) a camera path must keep from its structure's worst-case geometry. */
export const NEAR_CLEARANCE = 0.15;

/**
 * A strut lattice's entry: its own shader, camera, pulse topology, clearance and runtime, the
 * cubic budget otherwise.
 * @param {string} name @param {Structure["camera"]} camera @param {Structure["pulseSource"]} pulseSource
 * @param {Structure["clearance"]} clearance @param {Structure["runtime"]} runtime
 * @returns {Structure}
 */
function strutEntry(name, camera, pulseSource, clearance, runtime) {
  return { shader: `structure-${name}.glsl`, defines: [], camera, pulseSource, clearance, scale: 1, steps: 1, fog: 1, far: 36, runtime };
}

/** @type {Record<string, Structure>} */
export const STRUCTURES = {
  cubic: {
    shader: "structure-cubic.glsl",
    defines: [],
    camera: createCamera,
    pulseSource: nearestNode,
    clearance: cubicClearance,
    scale: 1,
    steps: 1,
    fog: 1,
    far: 36,
    runtime: cubicRuntime,
  },
  tentacle: {
    shader: "structure-tentacle.glsl",
    defines: ["MATERIALS"],
    camera: createCamera,
    pulseSource: nearestNode,
    clearance: tentacleClearance,
    // It costs several times the rods per pixel and leaves narrower channels: smaller render,
    // a little more march budget, thicker fog and a shorter march (fading out before it).
    scale: 0.85,
    steps: 1.1,
    fog: 1.5,
    far: 16,
    runtime: tentacleRuntime,
  },
  // Strut lattices (period 2), each flown along its own straight channels (lib/strut-camera.js).
  octet: strutEntry("octet", octet.octetCamera, octet.pulseSource, octet.clearance, octet.octetRuntime),
  diamond: strutEntry("diamond", diamond.diamondCamera, diamond.pulseSource, diamond.clearance, diamond.diamondRuntime),
  bitruncated: strutEntry("bitruncated", bitruncated.bitruncatedCamera, bitruncated.pulseSource, bitruncated.clearance, bitruncated.bitruncatedRuntime),
};

/** Lattice's Structure param options (Tentacle Lattice is its own visualizer, fixed to "tentacle"). */
export const STRUCTURE_OPTIONS = ["cubic", "octet", "diamond", "bitruncated"];

/**
 * The structure to render: Tentacle Lattice's own, else Lattice's Structure param (unknown → cubic).
 * @param {string} id `ctx.id` @param {unknown} param the Structure param
 */
export function structureFor(id, param) {
  if (id === "tentacle-lattice") return "tentacle";
  return STRUCTURE_OPTIONS.includes(String(param)) ? String(param) : "cubic";
}

/**
 * Join a shader: each `// #include name` line becomes `parts[name]`, and each define is added as
 * `#define NAME` right after the `#version` line.
 * @param {string} main @param {Record<string, string>} parts @param {string[]} defines
 */
export function assembleShader(main, parts, defines) {
  const body = main.replace(/^\/\/ #include (\S+)$/gm, (_, name) => {
    if (!(name in parts)) throw new Error(`lattice shader: no part "${name}" to include`);
    return parts[name];
  });
  if (defines.length === 0) return body;
  return body.replace(/^(#version[^\n]*\n)/, (v) => v + defines.map((d) => `#define ${d}\n`).join(""));
}
