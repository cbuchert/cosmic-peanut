// @ts-check
import { describe, expect, it } from "vitest";
import { densityRings, paletteIndex, paramDefault, ringGain, renderPath } from "./params.js";

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

describe("renderPath", () => {
  it("fine lines draw straight to the canvas", () => {
    expect(renderPath("fine", true)).toBe("canvas");
    expect(renderPath("fine", false)).toBe("canvas");
  });
  it("soft lines go through the 2× multisampled buffer only when antialiasing is on", () => {
    expect(renderPath("soft", true)).toBe("msaa");
    expect(renderPath("soft", false)).toBe("soft");
  });
  it("treats a missing antialias value as on (the manifest default)", () => {
    expect(renderPath("soft", undefined)).toBe("msaa");
  });
});

describe("paramDefault", () => {
  const manifest = /** @type {import("../../tidalviz").Manifest} */ (/** @type {unknown} */ ({
    apiVersion: 1,
    visualizers: [
      { id: "a", params: [{ id: "orbit", default: 0.12 }] },
      { id: "b", params: [{ id: "orbit", default: 0.3 }, { id: "pulse", default: 0.5 }] },
    ],
  }));
  it("reads a number param's default from the entry whose id is ctx.id, not the first one", () => {
    expect(paramDefault(manifest, "b", "orbit")).toBe(0.3);
    expect(paramDefault(manifest, "a", "orbit")).toBe(0.12);
    expect(paramDefault(manifest, "b", "pulse")).toBe(0.5);
  });
  it("is NaN when the entry or the param is missing", () => {
    expect(paramDefault(manifest, "a", "pulse")).toBeNaN();
    expect(paramDefault(manifest, "zzz", "orbit")).toBeNaN();
  });
});
