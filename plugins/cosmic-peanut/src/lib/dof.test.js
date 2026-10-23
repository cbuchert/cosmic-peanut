// @ts-check
import { describe, expect, it } from "vitest";
import { circleOfConfusion, createFocus, defocusSigma } from "./dof.js";
import { coverage } from "./quads.js";

describe("circleOfConfusion (thin lens, diameter ∝ |1 − focus ÷ depth|)", () => {
  it("is 0 in focus and grows in front of and behind the focal plane", () => {
    expect(circleOfConfusion(5, 5, 4, 10)).toBe(0);
    expect(circleOfConfusion(6, 5, 4, 10)).toBeGreaterThan(0);
    expect(circleOfConfusion(4, 5, 4, 10)).toBeGreaterThan(0);
    expect(circleOfConfusion(9, 5, 4, 10)).toBeGreaterThan(circleOfConfusion(6, 5, 4, 10));
    expect(circleOfConfusion(2, 5, 4, 10)).toBeGreaterThan(circleOfConfusion(4, 5, 4, 10));
  });
  it("tends to the aperture far away and is capped up close", () => {
    expect(circleOfConfusion(1e9, 5, 4, 10)).toBeCloseTo(4, 6);
    expect(circleOfConfusion(0.1, 5, 4, 10)).toBe(10);
  });
  it("is 0 everywhere with the aperture shut (no depth of field)", () => {
    for (const z of [0.5, 3, 40]) expect(circleOfConfusion(z, 5, 0, 10)).toBe(0);
  });
});

describe("defocusSigma", () => {
  it("adds the blur disk's variance (diameter c: (c/4)²) to the prefilter's", () => {
    expect(defocusSigma(0.5, 0)).toBe(0.5);
    expect(defocusSigma(0.5, 4)).toBeCloseTo(Math.hypot(0.5, 1), 12);
  });

  it("keeps a line's energy as it defocuses: wider, proportionally dimmer, same integral", () => {
    const h = 1;
    let lastPeak = Infinity;
    for (const c of [0, 1, 3, 8]) {
      const s = defocusSigma(0.5, c);
      let sum = 0;
      const e = h + 10 * s;
      for (let k = 0; k < 4000; k++) sum += coverage(-e + ((k + 0.5) * 2 * e) / 4000, h, s);
      expect((sum * 2 * e) / 4000).toBeCloseTo(2 * h, 3);
      const peak = coverage(0, h, s);
      expect(peak).toBeLessThan(lastPeak);
      lastPeak = peak;
    }
  });
});

describe("createFocus", () => {
  it("starts where it's told", () => {
    expect(createFocus(7).distance).toBe(7);
  });

  it("eases to a new target from rest, without overshoot, settled within 3 s", () => {
    const f = createFocus(4);
    const path = [];
    for (let k = 0; k < 180; k++) path.push(f.step(10, 1 / 60, false));
    expect(path[0] - 4).toBeLessThan(0.01); // starts slowly: no jump
    for (let k = 1; k < path.length; k++) {
      expect(path[k]).toBeGreaterThanOrEqual(path[k - 1]);
      expect(path[k]).toBeLessThanOrEqual(10);
    }
    expect(path.at(-1)).toBeGreaterThan(9.9);
  });

  it("follows a target that jumps (the next band ahead) smoothly, the same at any frame rate", () => {
    const a = createFocus(3);
    const b = createFocus(3);
    for (let k = 0; k < 120; k++) a.step(k < 60 ? 3 : 8, 1 / 120, false);
    for (let k = 0; k < 60; k++) b.step(k < 30 ? 3 : 8, 1 / 60, false);
    expect(a.distance).toBeCloseTo(b.distance, 1);
  });

  it("never pulls focus while held (Reduce motion)", () => {
    const f = createFocus(5);
    for (let k = 0; k < 120; k++) expect(f.step(k % 2 ? 2 : 12, 1 / 60, true)).toBe(5);
  });
});
