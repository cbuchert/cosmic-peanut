// @ts-check
import { describe, expect, it } from "vitest";
import { createRng } from "./marbling.js";
import { createSparks, SPARK_FLOATS, sparkColor } from "./sparks.js";

const DT = 1 / 60;
const N = 256;

/** Fuel only in columns [a, b). @param {number} a @param {number} b */
function fuelIn(a, b) {
  const f = new Float32Array(N);
  for (let i = a; i < b; i++) f[i] = 1;
  return f;
}

/** Run `s` for `seconds` with fixed inputs. */
function run(
  /** @type {ReturnType<typeof createSparks>} */ s,
  /** @type {number} */ seconds,
  /** @type {"iron" | "nickel" | null} */ kind,
  /** @type {Float32Array} */ fuel,
  stoke = 0.5,
  flare = 0,
) {
  for (let t = 0; t < seconds; t += DT) s.step(DT, kind, fuel, stoke, flare);
}

describe("createSparks", () => {
  it("throws nothing without a spark kind or without fuel", () => {
    const s = createSparks(512, createRng(1));
    run(s, 1, null, fuelIn(0, N));
    expect(s.count).toBe(0);
    run(s, 1, "iron", new Float32Array(N), 1, 1);
    expect(s.count).toBe(0);
  });

  it("launches sparks from where the fuel is, at the bottom", () => {
    const s = createSparks(512, createRng(2));
    s.step(DT * 6, "nickel", fuelIn(100, 110), 1, 1);
    expect(s.count).toBeGreaterThan(0);
    for (let i = 0; i < s.count; i++) {
      expect(s.x[i]).toBeGreaterThanOrEqual(100 / N - 0.01);
      expect(s.x[i]).toBeLessThanOrEqual(110 / N + 0.01);
      expect(s.y[i]).toBeLessThan(0.15);
    }
  });

  it("arcs: sparks fly up, gravity bends them down, and every one burns out", () => {
    const s = createSparks(512, createRng(3));
    s.step(DT, "nickel", fuelIn(0, N), 1, 1);
    const n = s.count;
    expect(n).toBeGreaterThan(0);
    const vy0 = s.vy[0];
    expect(vy0).toBeGreaterThan(0);
    s.step(0.3, null, fuelIn(0, N));
    expect(s.vy[0]).toBeLessThan(vy0);
    run(s, 4, null, fuelIn(0, N));
    expect(s.count).toBe(0);
  });

  it("throws more sparks when the music is louder", () => {
    const quiet = createSparks(4096, createRng(4));
    const loud = createSparks(4096, createRng(4));
    run(quiet, 0.5, "iron", fuelIn(0, N), 0, 0);
    run(loud, 0.5, "iron", fuelIn(0, N), 1, 1);
    expect(loud.count).toBeGreaterThan(2 * quiet.count);
  });

  it("never holds more than its capacity", () => {
    const s = createSparks(64, createRng(5));
    for (let t = 0; t < 2; t += DT) {
      s.step(DT, "iron", fuelIn(0, N), 1, 1);
      expect(s.count).toBeLessThanOrEqual(64);
    }
  });

  it("iron sparks fork into bursts; nickel sparks never do", () => {
    const iron = createSparks(4096, createRng(6));
    const nickel = createSparks(4096, createRng(6));
    let forked = 0;
    for (let t = 0; t < 2; t += DT) {
      iron.step(DT, "iron", fuelIn(0, N), 0.6, 0);
      nickel.step(DT, "nickel", fuelIn(0, N), 0.6, 0);
      for (let i = 0; i < iron.count; i++) if (iron.gen[i] > 0) forked++;
      for (let i = 0; i < nickel.count; i++) expect(nickel.gen[i]).toBe(0);
    }
    expect(forked).toBeGreaterThan(0);
  });

  it("clear() drops every spark", () => {
    const s = createSparks(512, createRng(7));
    run(s, 0.5, "iron", fuelIn(0, N), 1, 1);
    s.clear();
    expect(s.count).toBe(0);
  });

  it("fill writes one quad (6 vertices) per spark, all finite", () => {
    const s = createSparks(512, createRng(8));
    run(s, 0.5, "iron", fuelIn(0, N), 1, 1);
    const verts = new Float32Array(512 * 6 * SPARK_FLOATS);
    const n = s.fill(verts, 16 / 9, 0.004);
    expect(n).toBe(6 * s.count);
    for (let i = 0; i < n * SPARK_FLOATS; i++) expect(Number.isFinite(verts[i]), `float ${i}`).toBe(true);
  });
});

describe("sparkColor", () => {
  it("iron burns gold-orange and nickel whiter, both fading to nothing", () => {
    const c = new Float32Array(4);
    sparkColor("iron", 0.3, 0, c);
    const [ir, ig, ib] = c;
    expect(ir).toBeGreaterThan(ig);
    expect(ig).toBeGreaterThan(ib);
    sparkColor("nickel", 0.3, 0, c);
    expect(c[2] / c[0]).toBeGreaterThan(ib / ir + 0.2);
    for (const k of /** @type {const} */ (["iron", "nickel"])) {
      sparkColor(k, 1, 0, c);
      expect(Math.max(c[0], c[1], c[2], c[3]), k).toBe(0);
      sparkColor(k, 0.2, 0, c);
      expect(c[3]).toBeCloseTo(Math.max(c[0], c[1], c[2]), 6); // premultiplied, alpha = brightest
    }
  });

  it("forked children burn hotter and briefer than their parent's glow", () => {
    const parent = new Float32Array(4);
    const child = new Float32Array(4);
    sparkColor("iron", 0.5, 0, parent);
    sparkColor("iron", 0.5, 1, child);
    expect(child[2] / child[0]).toBeGreaterThan(parent[2] / parent[0]); // whiter = hotter
  });
});
