// @ts-check
import { describe, expect, it } from "vitest";
import { GENTLE, gentle } from "./motion.js";

describe("reduced motion", () => {
  it("uses the gentle value only while reduced motion is on and the user kept the default", () => {
    expect(GENTLE).toEqual({ orbit: 0, pulse: 0.1, beat: 0.25, speed: 0.25, surge: 0 });
    expect(gentle(1, 1, true, GENTLE.beat)).toBe(0.25); // Möbius's wring and breath
    expect(gentle(0.12, 0.12, true, GENTLE.orbit)).toBe(0);
    expect(gentle(0.35, 0.35, true, GENTLE.pulse)).toBe(0.1);
    expect(gentle(0.3, 0.12, true, GENTLE.orbit)).toBe(0.3); // the user raised it: respected
    expect(gentle(0.12, 0.12, false, GENTLE.orbit)).toBe(0.12);
    // Möbius Field: the flight slows a lot (and its curves with it) and the beat surge goes.
    expect(gentle(1.4, 1.4, true, GENTLE.speed)).toBe(0.25);
    expect(gentle(1, 1, true, GENTLE.surge)).toBe(0);
  });
});
