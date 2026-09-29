// @ts-check
import { describe, expect, it } from "vitest";
import { clampDrag, dragForward, dragInverse, dropForward, dropInverse } from "./marbling.js";

const out = new Float64Array(2);

describe("drop", () => {
  it("pushes a point radially outward so that |p' - c|² = |p - c|² + r²", () => {
    dropForward(0.5, 0.5, 0.01, 0.8, 0.5, out);
    expect(out[0]).toBeCloseTo(0.5 + Math.sqrt(0.3 ** 2 + 0.01), 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
  });

  it("inverts exactly: forward then inverse is the identity everywhere outside the drop", () => {
    const back = new Float64Array(2);
    for (let i = 0; i < 200; i++) {
      const px = (i * 0.618) % 1.7;
      const py = (i * 0.414) % 1;
      dropForward(0.9, 0.4, 0.02, px, py, out);
      expect(dropInverse(0.9, 0.4, 0.02, out[0], out[1], back)).toBe(false);
      expect(back[0]).toBeCloseTo(px, 9);
      expect(back[1]).toBeCloseTo(py, 9);
    }
  });

  it("reports points inside the new drop (they take the drop's paint, not a pre-image)", () => {
    const back = new Float64Array(2);
    expect(dropInverse(0.5, 0.5, 0.01, 0.55, 0.52, back)).toBe(true);
    expect(dropInverse(0.5, 0.5, 0.01, 0.62, 0.5, back)).toBe(false);
  });
});

describe("drop area", () => {
  it("moves every outside point outward and maps an annulus to one of equal area", () => {
    const r2 = 0.004;
    for (const [a, b] of [[0.05, 0.08], [0.2, 0.3]]) {
      const ra = dropForward(0, 0, r2, a, 0, out)[0];
      const rb = dropForward(0, 0, r2, 0, b, out)[1];
      expect(ra).toBeGreaterThan(a);
      expect(rb * rb - ra * ra).toBeCloseTo(b * b - a * a, 12);
    }
  });
});

describe("stylus drag", () => {
  const invS2 = 1 / 0.03 ** 2;
  it("drags paint at the stylus along its motion, falling off with distance", () => {
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.5, out);
    expect(out[0]).toBeCloseTo(0.51, 12);
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.53, out);
    expect(out[0] - 0.5).toBeCloseTo(0.01 * Math.exp(-1), 12);
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.8, out);
    expect(out[0] - 0.5).toBeLessThan(1e-12);
  });

  it("clamps the motion so the map stays invertible, and the inverse round-trips", () => {
    const v = new Float64Array([0.5, 0.2]);
    clampDrag(invS2, v);
    const lim = 0.25 / Math.sqrt((2 * invS2) / Math.E);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(lim, 12);
    const back = new Float64Array(2);
    for (let i = 0; i < 200; i++) {
      const px = 0.45 + (i % 20) * 0.005;
      const py = 0.45 + Math.floor(i / 20) * 0.01;
      dragForward(0.5, 0.5, v[0], v[1], invS2, px, py, out);
      dragInverse(0.5, 0.5, v[0], v[1], invS2, out[0], out[1], back);
      expect(Math.abs(back[0] - px)).toBeLessThan(1e-4 * lim);
      expect(Math.abs(back[1] - py)).toBeLessThan(1e-4 * lim);
    }
  });

  it("leaves a small motion unclamped", () => {
    const v = new Float64Array([0.001, 0]);
    clampDrag(invS2, v);
    expect(v[0]).toBe(0.001);
  });
});

