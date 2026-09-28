// @ts-check
import { describe, expect, it } from "vitest";
import { createBandGain, mapMirrored, shapeLevel } from "./fuel.js";

const DT = 1 / 60;

describe("mapMirrored", () => {
  it("puts the bass at the centre and the highs at both edges, symmetrically", () => {
    const bands = new Float32Array(64).map((_, i) => i / 63); // level = band position
    const out = new Float32Array(256);
    mapMirrored(bands, out);
    expect(out[127]).toBeLessThan(0.02);
    expect(out[128]).toBeLessThan(0.02);
    expect(out[0]).toBeGreaterThan(0.98);
    expect(out[255]).toBeGreaterThan(0.98);
    for (let i = 0; i < 128; i++) {
      expect(out[i]).toBeCloseTo(out[255 - i], 6);
      if (i > 0) expect(out[i]).toBeLessThanOrEqual(out[i - 1]); // falls toward the centre
    }
  });
});

describe("shapeLevel", () => {
  it("gates the noise floor and expands: steeper than linear, monotonic, 0–1", () => {
    expect(shapeLevel(0.1, 1)).toBe(0); // under the gate
    expect(shapeLevel(1, 1)).toBeCloseTo(1, 6);
    expect(shapeLevel(0.5, 1)).toBeLessThan(0.35); // expanded well below linear
    let prev = 0;
    for (let n = 0; n <= 1.0001; n += 0.01) {
      const v = shapeLevel(n, 1);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(shapeLevel(2, 1)).toBeCloseTo(1, 6); // clamped
  });

  it("reactivity sets the drama: 0 is linear and ungated, 2 gates and expands harder", () => {
    for (const n of [0.1, 0.4, 0.7]) {
      expect(shapeLevel(n, 0)).toBeCloseTo(n, 6);
    }
    for (const n of [0.4, 0.7]) expect(shapeLevel(n, 2)).toBeLessThan(shapeLevel(n, 1));
  });
});

/** Run a band gain on a fixed spectrum for `seconds`; returns its last output. */
function settle(/** @type {ReturnType<typeof createBandGain>} */ g, /** @type {Float32Array} */ bands, seconds, dt = DT) {
  const out = new Float32Array(bands.length);
  for (let t = 0; t < seconds; t += dt) g.step(bands, dt, out);
  return out;
}

describe("createBandGain", () => {
  it("loud bands normalise high and quiet bands stay near the floor once shaped", () => {
    const bands = new Float32Array(64).map((_, i) => (i < 16 ? 0.8 : 0.08));
    const out = settle(createBandGain(64), bands, 3);
    for (let i = 0; i < 16; i++) expect(shapeLevel(out[i], 1)).toBeGreaterThan(0.9);
    for (let i = 16; i < 64; i++) expect(shapeLevel(out[i], 1)).toBeLessThan(0.1);
  });

  it("normalises a quiet mix to the same profile, but keeps silence and hiss out", () => {
    const loud = new Float32Array(64).map((_, i) => 0.9 * Math.exp(-i / 20));
    const quiet = loud.map((v) => v * 0.25);
    const a = settle(createBandGain(64), loud, 3);
    const b = settle(createBandGain(64), quiet, 3);
    for (let i = 0; i < 40; i++) expect(b[i]).toBeCloseTo(a[i], 4); // above the floor
    const hiss = settle(createBandGain(64), new Float32Array(64).fill(0.004), 3);
    for (let i = 0; i < 64; i++) expect(shapeLevel(hiss[i], 1)).toBe(0);
  });
});
