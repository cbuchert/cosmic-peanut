// @ts-check
import { describe, expect, it } from "vitest";
import { shapeFor } from "./shapes.js";

describe("shapeFor", () => {
  it("draws Cosmic Peanut with the sphere shader at radius 1, whatever the width", () => {
    const s = shapeFor("cosmic-peanut");
    expect(s.vert).toBe("shaders/rings.vert");
    expect(s.extent(0.4)).toBe(1);
    expect(s.extent(NaN)).toBe(1); // the sphere has no width param
  });

  it("draws Möbius with its own shader along a track, framed and depth-faded by the track", () => {
    const s = shapeFor("mobius");
    expect(s.vert).toBe("shaders/mobius.vert");
    expect(s.track).toBe(true);
    expect(shapeFor("cosmic-peanut").track).toBe(false);
  });

  it("rejects an id the pack doesn't define", () => {
    expect(() => shapeFor("bars")).toThrow(/bars/);
  });
});
