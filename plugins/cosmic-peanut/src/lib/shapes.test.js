// @ts-check
import { describe, expect, it } from "vitest";
import { cameraDistance } from "./camera.js";
import { shapeFor } from "./shapes.js";

describe("shapeFor", () => {
  it("draws Cosmic Peanut with the sphere shader at radius 1, whatever the width", () => {
    const s = shapeFor("cosmic-peanut");
    expect(s.vert).toBe("shaders/rings.vert");
    expect(s.extent(0.4)).toBe(1);
    expect(s.extent(NaN)).toBe(1); // the sphere has no width param
  });

  it("draws Möbius with its own shader; the strip reaches R + W = 1 + width from the center", () => {
    const s = shapeFor("mobius");
    expect(s.vert).toBe("shaders/mobius.vert");
    expect(s.extent(0.4)).toBeCloseTo(1.4, 12);
    expect(s.extent(0.15)).toBeCloseTo(1.15, 12);
  });

  it("frames the Möbius strip so R + W + amp fits with the sphere's 1.32 margin", () => {
    const fit = ((1 + 0.4 + 0.22) * 1.32) / Math.tan((19 * Math.PI) / 180);
    expect(cameraDistance(0.22, 16 / 9, shapeFor("mobius").extent(0.4))).toBeCloseTo(fit, 9);
    expect(cameraDistance(0.22, 9 / 16, shapeFor("mobius").extent(0.4))).toBeCloseTo(fit / (9 / 16), 9);
  });

  it("rejects an id the pack doesn't define", () => {
    expect(() => shapeFor("bars")).toThrow(/bars/);
  });
});
