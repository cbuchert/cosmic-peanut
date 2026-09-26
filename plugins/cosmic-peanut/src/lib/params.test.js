// @ts-check
import { describe, expect, it } from "vitest";
import { densityRings, paletteIndex, ringGain } from "./params.js";

describe("densityRings", () => {
  it("maps sparse/medium/dense to 120/240/400 rings, medium for anything else", () => {
    expect(densityRings("sparse")).toBe(120);
    expect(densityRings("medium")).toBe(240);
    expect(densityRings("dense")).toBe(400);
    expect(densityRings("bogus")).toBe(240);
  });
});

describe("paletteIndex", () => {
  it("maps nebula/ember/phosphor to the shader's 0/1/2", () => {
    expect([paletteIndex("nebula"), paletteIndex("ember"), paletteIndex("phosphor")]).toEqual([0, 1, 2]);
    expect(paletteIndex("?")).toBe(0);
  });
});

describe("ringGain", () => {
  it("scales with √(240 ÷ N) so density doesn't change total brightness, × 1.35 for fine lines", () => {
    expect(ringGain(1, 240, false)).toBeCloseTo(0.55, 9);
    expect(ringGain(2, 240, false)).toBeCloseTo(1.1, 9);
    expect(ringGain(1, 60, false)).toBeCloseTo(1.1, 9);
    expect(ringGain(1, 240, true)).toBeCloseTo(0.55 * 1.35, 9);
  });
});
