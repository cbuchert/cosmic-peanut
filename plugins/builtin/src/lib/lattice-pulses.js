// @ts-check
import { FALL, RISE } from "./lattice-beat.js";

/**
 * Lattice's beat pulses: a fixed pool of light fronts, each launched on a beat from one lattice
 * node and travelling outward along the rods. On the rod network the shortest path from a node
 * to any point on a rod is the L1 (Manhattan) distance, so the shader lights a rod point by how
 * close its L1 distance from the pulse's node is to the pulse's `front`.
 *
 * A pulse eases in over RISE (80 ms, a smoothstep) and out by FALL beats (another), the same shape
 * as lib/lattice-beat.js, while its front runs REACH cells at a steady pace. Nothing is allocated
 * per step.
 */

/** Pulses in flight (uniform array size in the shader). */
export const PULSE_CAP = 8;
/** Cells a pulse's front travels over its life (it is gone as the next beat launches). */
export const REACH = 3;

/** Under Reduce flashing: pulse brightness scale, and the fewest seconds between launches. */
export const REDUCED_LEVEL = 0.3;
const REDUCED_GAP = 1 / 3;

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The cubic lattices' pulse topology: a pulse starts at the node nearest the point. */
export function nearestNode(/** @type {ArrayLike<number>} */ point, /** @type {Float64Array} */ out) {
  for (let c = 0; c < 3; c++) out[c] = Math.round(point[c]);
  return out;
}

/**
 * @param {(point: ArrayLike<number>, out: Float64Array) => Float64Array} [snap] where a pulse
 *   launched near `point` starts (a structure's pulse topology; default: the nearest node)
 */
export function createPulses(snap = nearestNode) {
  const node = new Float64Array(PULSE_CAP * 3);
  const at = new Float64Array(3);
  const level = new Float32Array(PULSE_CAP);
  const age = new Float32Array(PULSE_CAP).fill(Infinity);
  const life = new Float32Array(PULSE_CAP).fill(1);
  const reach = new Float32Array(PULSE_CAP).fill(1);
  let next = 0;
  let since = Infinity; // seconds since the last launch
  const p = {
    /** Per pulse: its node relative to the origin (x, y, z) and its front distance (cells). */
    data: new Float32Array(PULSE_CAP * 4),
    /** Per pulse: brightness, 0–2 (0 = idle). */
    amp: new Float32Array(PULSE_CAP),
    /** The live pulses' `data` and `amp`, packed first, and how many there are. */
    live: new Float32Array(PULSE_CAP * 4),
    liveAmp: new Float32Array(PULSE_CAP),
    liveCount: 0,
    /**
     * Launch a pulse from where the topology puts `point` (cells; by default its nearest node).
     * @param {ArrayLike<number>} point @param {number} lvl brightness (beat level × Reactivity, 0–2)
     * @param {boolean} reduceFlashing
     * @param {number} period seconds per beat
     * @param {number} [scale] fraction of REACH to travel (motionScale: Reduce motion shortens it)
     * @returns {boolean} whether it launched (Reduce flashing spaces launches REDUCED_GAP apart)
     */
    launch(point, lvl, reduceFlashing, period, scale = 1) {
      if (reduceFlashing && since < REDUCED_GAP) return false;
      since = 0;
      const i = next;
      next = (next + 1) % PULSE_CAP;
      snap(point, at);
      for (let c = 0; c < 3; c++) node[i * 3 + c] = at[c];
      level[i] = reduceFlashing ? REDUCED_LEVEL * lvl : lvl;
      age[i] = 0;
      life[i] = Math.max(RISE + 0.05, FALL * period);
      reach[i] = REACH * scale;
      return true;
    },
    /**
     * Age the pulses and write `data` / `amp` relative to `origin` (integer cell coordinates).
     * @param {number} dt seconds @param {ArrayLike<number>} origin
     */
    step(dt, origin) {
      since += dt;
      for (let i = 0; i < PULSE_CAP; i++) {
        age[i] += dt;
        for (let c = 0; c < 3; c++) p.data[i * 4 + c] = node[i * 3 + c] - origin[c];
        const a = age[i];
        const L = life[i];
        p.data[i * 4 + 3] = (reach[i] * Math.min(a, L)) / L;
        p.amp[i] = !(a < L) ? 0 : a < RISE ? level[i] * smooth(a / RISE) : level[i] * (1 - smooth((a - RISE) / (L - RISE)));
      }
      let n = 0;
      for (let i = 0; i < PULSE_CAP; i++) {
        if (!(p.amp[i] > 0)) continue;
        for (let c = 0; c < 4; c++) p.live[n * 4 + c] = p.data[i * 4 + c];
        p.liveAmp[n++] = p.amp[i];
      }
      p.liveCount = n;
      return p;
    },
  };
  return p;
}
