// @ts-check
/**
 * Sparks for Blaze's iron and nickel palettes: glowing bits of metal thrown up from the fuel line,
 * arcing under gravity and cooling along the blackbody curve. Iron sparks fork into short star
 * bursts (the carbon in steel burns explosively); nickel sparks burn whiter and never fork.
 *
 * Allocation-free per frame: a fixed structure-of-arrays pool, swap-removed on death.
 * Positions: x 0–1 across the canvas, y 0–1 up (canvas heights); velocities per second.
 */
import { blackbody } from "./fire.js";

/** Floats per vertex written by `fill`: clip x, y, premultiplied r, g, b, a, side (−1…1). */
export const SPARK_FLOATS = 7;

const GRAVITY = 1.1; // heights/s²
const DRAG = 0.6; // 1/s
const RATE = 90; // sparks/s at stoke 1 before the onset term
const STREAK = 0.035; // s of motion drawn behind each spark

/** @typedef {"iron" | "nickel"} SparkKind */
const KINDS = /** @type {const} */ ({
  iron: { id: 1, T0: 2000, T1: 1000, white: 0, fork: 1.4, life: 0.7 },
  nickel: { id: 2, T0: 2600, T1: 1400, white: 0.7, fork: 0, life: 0.8 },
});
/** @type {(SparkKind | null)[]} */
const BY_ID = [null, "iron", "nickel"];
// Corner order for one streak: tail−, tail+, head+ and tail−, head+, head−.
const HEAD = [0, 0, 1, 0, 1, 1];
const SIDE = [-1, 1, 1, -1, 1, -1];

/**
 * @param {number} capacity most sparks alive at once
 * @param {() => number} [rand] uniform 0–1 (seed it for tests and stills)
 */
export function createSparks(capacity, rand = Math.random) {
  const x = new Float32Array(capacity);
  const y = new Float32Array(capacity);
  const vx = new Float32Array(capacity);
  const vy = new Float32Array(capacity);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const gen = new Uint8Array(capacity); // 0 = thrown from the fire, 1 = forked from a burst
  const kindOf = new Uint8Array(capacity);
  const col = new Float32Array(4);
  let owed = 0; // fractional sparks carried between steps

  /** @param {number} px @param {number} py @param {number} pvx @param {number} pvy @param {number} plife @param {number} g @param {number} k */
  function add(px, py, pvx, pvy, plife, g, k) {
    const i = api.count;
    if (i >= capacity) return;
    x[i] = px;
    y[i] = py;
    vx[i] = pvx;
    vy[i] = pvy;
    age[i] = 0;
    life[i] = plife;
    gen[i] = g;
    kindOf[i] = k;
    api.count = i + 1;
  }

  /** @param {number} i */
  function remove(i) {
    const j = --api.count;
    x[i] = x[j];
    y[i] = y[j];
    vx[i] = vx[j];
    vy[i] = vy[j];
    age[i] = age[j];
    life[i] = life[j];
    gen[i] = gen[j];
    kindOf[i] = kindOf[j];
  }

  const api = {
    count: 0,
    x,
    y,
    vy,
    gen,

    /**
     * Move, cool, fork and retire the live sparks, then throw new ones from the fuel line.
     * @param {number} dt seconds
     * @param {SparkKind | null} kind what to throw now (null: none; live sparks still finish)
     * @param {Float32Array} fuel fuel per column along the bottom, left → right
     * @param {number} [stoke] 0–1, the bass push
     * @param {number} [flare] 0–1, the onset burst
     */
    step(dt, kind, fuel, stoke = 0, flare = 0) {
      const damp = Math.exp(-DRAG * dt);
      for (let i = api.count - 1; i >= 0; i--) {
        age[i] += dt;
        vy[i] = (vy[i] - GRAVITY * dt) * damp;
        vx[i] *= damp;
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        if (age[i] >= life[i] || y[i] < -0.05) {
          remove(i);
          continue;
        }
        const k = BY_ID[kindOf[i]];
        if (k && gen[i] === 0 && age[i] > 0.25 * life[i] && rand() < KINDS[k].fork * dt) {
          // Burst: the spark ends in a star of short, hot children.
          const n = 3 + Math.floor(rand() * 3);
          for (let c = 0; c < n; c++) {
            const a = rand() * 2 * Math.PI;
            const s = 0.25 + 0.3 * rand();
            add(x[i], y[i], 0.5 * vx[i] + s * Math.cos(a), 0.5 * vy[i] + s * Math.sin(a), 0.12 + 0.18 * rand(), 1, kindOf[i]);
          }
          remove(i);
        }
      }

      if (!kind) {
        owed = 0;
        return;
      }
      let maxF = 0;
      for (let i = 0; i < fuel.length; i++) if (fuel[i] > maxF) maxF = fuel[i];
      if (!(maxF > 0)) {
        owed = 0;
        return;
      }
      const spec = KINDS[kind];
      owed += RATE * (0.3 + stoke + 2 * flare) * dt;
      while (owed >= 1) {
        owed -= 1;
        // Rejection-sample a column by its fuel, so sparks fly from the loud parts of the fire.
        for (let tries = 0; tries < 8; tries++) {
          const c = Math.floor(rand() * fuel.length);
          if (rand() * maxF >= fuel[c]) continue;
          add(
            (c + rand()) / fuel.length,
            0.01 + 0.03 * rand(),
            (rand() - 0.5) * 0.5,
            0.7 + rand() + 0.6 * flare,
            spec.life * (1 + rand()),
            0,
            spec.id,
          );
          break;
        }
      }
    },

    /**
     * Write each spark as a soft streak (two triangles from where it was STREAK s ago to where it
     * is) into `verts`, SPARK_FLOATS per vertex. Returns the vertex count.
     * @param {Float32Array} verts room for count × 6 vertices
     * @param {number} aspect canvas width / height
     * @param {number} width streak width in canvas heights
     */
    fill(verts, aspect, width) {
      let o = 0;
      for (let i = 0; i < api.count; i++) {
        sparkColor(BY_ID[kindOf[i]] ?? "iron", age[i] / life[i], gen[i], col);
        // Work in height units so the streak keeps its width at any aspect.
        const hx = x[i] * aspect;
        const hy = y[i];
        const tx = hx - vx[i] * aspect * STREAK;
        const ty = hy - vy[i] * STREAK;
        const len = Math.hypot(hx - tx, hy - ty);
        const nx = len > 1e-6 ? (-(hy - ty) / len) * width * 0.5 : width * 0.5;
        const ny = len > 1e-6 ? ((hx - tx) / len) * width * 0.5 : 0;
        for (let v = 0; v < 6; v++) {
          const s = SIDE[v];
          const px = HEAD[v] ? hx : tx;
          const py = HEAD[v] ? hy : ty;
          verts[o++] = ((px + s * nx) / aspect) * 2 - 1;
          verts[o++] = (py + s * ny) * 2 - 1;
          verts[o++] = col[0];
          verts[o++] = col[1];
          verts[o++] = col[2];
          verts[o++] = col[3];
          verts[o++] = s;
        }
      }
      return 6 * api.count;
    },

    clear() {
      api.count = 0;
      owed = 0;
    },
  };
  return api;
}

const bb = new Float32Array(3);

/**
 * A spark's premultiplied colour at `ageFrac` (0 born … 1 dead): blackbody at a temperature that
 * cools over its life (forked children start hotter), nickel mixed toward white, fading out.
 * @param {SparkKind} kind
 * @param {number} ageFrac
 * @param {number} g generation (0 thrown, 1 forked)
 * @param {Float32Array} out length ≥ 4
 */
export function sparkColor(kind, ageFrac, g, out) {
  const k = KINDS[kind];
  const a = ageFrac < 0 ? 0 : ageFrac > 1 ? 1 : ageFrac;
  blackbody(k.T0 + (g ? 500 : 0) + (k.T1 - k.T0) * a, bb);
  const fade = (1 - a) ** 1.5;
  for (let c = 0; c < 3; c++) out[c] = (bb[c] + (1 - bb[c]) * k.white) * fade;
  out[3] = Math.max(out[0], out[1], out[2]);
  return out;
}
