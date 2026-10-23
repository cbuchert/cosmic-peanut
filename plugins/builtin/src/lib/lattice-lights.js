// @ts-check
/**
 * The cinematic look's beat-pulse lights: each live pulse's travelling front becomes a few tube
 * lights (representative-point tube lights, Karis, "Real Shading in Unreal Engine 4", SIGGRAPH 2013
 * course), so a pulse lights the surfaces it passes with real diffuse and specular, and glows in
 * the fog (shade.glsl). Only the LIGHT_CAP tubes nearest a focus point just ahead of the camera
 * are packed, and each tube's power fades to 0 at LIGHT_REACH from it, so a tube that drops out
 * of the pack has already faded (no pop).
 *
 * A structure supplies its pulse-light topology (`pulseLights` in lib/structures.js): strut
 * lattices whose pulse metric is the L1 distance use `strutFrontLights`; any structure without one
 * gets `pointPulseLight`, a point light at the pulse's source.
 *
 * Nothing here allocates per frame.
 */

/** Tube lights packed per frame (shade.glsl LIGHT_CAP). */
export const LIGHT_CAP = 12;
/** Cells from the focus where a tube's power has faded to 0 (it fades from 0.6 × this). */
export const LIGHT_REACH = 3.5;
/** How far ahead of the front a lit strut's tube reaches, and how far behind (its wake), cells. */
export const FRONT_LEAD = 0.15;
export const FRONT_WAKE = 0.45;
/** Under Reduce flashing the pulse lights are scaled by this too (on top of the pulses' own dimming). */
export const REDUCED_LIGHT = 0.2;

/** @typedef {{ add: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, power: number) => void }} LightSink */
/**
 * A structure's pulse-light topology: add the tube lights of pulse slot `i` (`data` is
 * lib/lattice-pulses.js `data`: source x, y, z relative to the origin, then the front distance;
 * `amp` its brightness) to `sink`.
 * @typedef {(data: Float32Array, i: number, amp: number, sink: LightSink) => void} PulseLights
 */

/** @param {number} e0 @param {number} e1 @param {number} x */
const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The per-frame light pack: `a` holds each tube's end a (xyz) and radius, `b` its end b (xyz) and
 * power, nearest the focus first; `count` how many are live.
 * @param {number} [cap]
 */
export function createLightPack(cap = LIGHT_CAP) {
  const dist = new Float32Array(cap);
  let fx = 0;
  let fy = 0;
  let fz = 0;
  const pack = {
    a: new Float32Array(cap * 4),
    b: new Float32Array(cap * 4),
    count: 0,
    /** Start a frame's pack around the focus (cells, relative to the origin). @param {number} x @param {number} y @param {number} z */
    begin(x, y, z) {
      fx = x;
      fy = y;
      fz = z;
      pack.count = 0;
    },
    /**
     * Offer a tube from a to b (a point when a = b) of `power`: kept if it is among the `cap`
     * nearest the focus (by its nearest point) and within LIGHT_REACH.
     * @type {LightSink["add"]}
     */
    add(ax, ay, az, bx, by, bz, power) {
      const ex = bx - ax;
      const ey = by - ay;
      const ez = bz - az;
      const ll = ex * ex + ey * ey + ez * ez;
      const s = ll > 0 ? Math.max(0, Math.min(1, ((fx - ax) * ex + (fy - ay) * ey + (fz - az) * ez) / ll)) : 0;
      const dx = ax + ex * s - fx;
      const dy = ay + ey * s - fy;
      const dz = az + ez * s - fz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= LIGHT_REACH || power <= 0) return;
      let n = pack.count;
      if (n === cap) {
        if (d >= dist[cap - 1]) return;
        n--; // drop the farthest
      }
      // Insertion: shift the farther ones down one slot.
      let i = n;
      while (i > 0 && dist[i - 1] > d) {
        dist[i] = dist[i - 1];
        for (let c = 0; c < 4; c++) {
          pack.a[i * 4 + c] = pack.a[i * 4 - 4 + c];
          pack.b[i * 4 + c] = pack.b[i * 4 - 4 + c];
        }
        i--;
      }
      dist[i] = d;
      pack.a[i * 4] = ax;
      pack.a[i * 4 + 1] = ay;
      pack.a[i * 4 + 2] = az;
      pack.a[i * 4 + 3] = 0;
      pack.b[i * 4] = bx;
      pack.b[i * 4 + 1] = by;
      pack.b[i * 4 + 2] = bz;
      pack.b[i * 4 + 3] = power * (1 - smoothstep(0.6 * LIGHT_REACH, LIGHT_REACH, d));
      pack.count = n + 1;
    },
    end() {
      for (let i = pack.count; i < cap; i++) pack.b[i * 4 + 3] = 0;
    },
  };
  return pack;
}

/**
 * Strut lattices with the L1 pulse metric (cubic, tentacle): on the strut graph every strut joins
 * a node at L1 distance k from the source to one at k + 1, and its L1 distance rises linearly
 * along it. Each strut whose span [k, k + 1] meets the front's lit band [front − FRONT_WAKE,
 * front + FRONT_LEAD] gets a tube over that part: the shells k with k > front − FRONT_WAKE − 1 and
 * k < front + FRONT_LEAD, each node in them, each axis direction leading away from the source.
 * @type {PulseLights}
 */
export function strutFrontLights(data, i, amp, sink) {
  const sx = data[i * 4];
  const sy = data[i * 4 + 1];
  const sz = data[i * 4 + 2];
  const f = data[i * 4 + 3];
  const k0 = Math.max(0, Math.floor(f - FRONT_WAKE - 1) + 1);
  const k1 = Math.ceil(f + FRONT_LEAD) - 1;
  for (let k = k0; k <= k1; k++) {
    const lo = Math.max(0, f - FRONT_WAKE - k);
    const hi = Math.min(1, f + FRONT_LEAD - k);
    if (!(lo < hi)) continue;
    for (let dx = -k; dx <= k; dx++) {
      const rx = k - Math.abs(dx);
      for (let dy = -rx; dy <= rx; dy++) {
        const rz = rx - Math.abs(dy);
        for (let side = 0; side < (rz === 0 ? 1 : 2); side++) {
          const dz = side === 0 ? rz : -rz;
          const mx = sx + dx;
          const my = sy + dy;
          const mz = sz + dz;
          // Directions leading away from the source: along a coordinate that already differs, the
          // way it differs; along one that is equal, both ways.
          for (let c = 0; c < 3; c++) {
            const off = c === 0 ? dx : c === 1 ? dy : dz;
            for (let s = -1; s <= 1; s += 2) {
              if (off !== 0 && Math.sign(off) !== s) continue;
              sink.add(
                mx + (c === 0 ? s * lo : 0),
                my + (c === 1 ? s * lo : 0),
                mz + (c === 2 ? s * lo : 0),
                mx + (c === 0 ? s * hi : 0),
                my + (c === 1 ? s * hi : 0),
                mz + (c === 2 ? s * hi : 0),
                amp,
              );
            }
          }
        }
      }
    }
  }
}

/** Any structure without its own topology: a point light at the pulse's source. @type {PulseLights} */
export function pointPulseLight(data, i, amp, sink) {
  const x = data[i * 4];
  const y = data[i * 4 + 1];
  const z = data[i * 4 + 2];
  sink.add(x, y, z, x, y, z, amp);
}

/**
 * Pack a frame's pulse lights: every live pulse (amp > 0) through the structure's topology, kept
 * by distance from the focus (fx, fy, fz).
 * @param {ReturnType<typeof createLightPack>} pack
 * @param {{ data: Float32Array, amp: Float32Array }} pulses lib/lattice-pulses.js (after `step`)
 * @param {number} fx @param {number} fy @param {number} fz @param {PulseLights} lights
 * @param {number} [gain] scale on every light's power (REDUCED_LIGHT under Reduce flashing)
 */
export function packPulseLights(pack, pulses, fx, fy, fz, lights, gain = 1) {
  pack.begin(fx, fy, fz);
  for (let i = 0; i < pulses.amp.length; i++) {
    if (pulses.amp[i] > 0) lights(pulses.data, i, pulses.amp[i] * gain, pack);
  }
  pack.end();
}
