// @ts-check
import { describe, expect, it } from "vitest";
import { mapMirrored, shapeLevel } from "./fuel.js";

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
