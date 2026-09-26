// @ts-check
import { describe, expect, it } from "vitest";
import { createPushScheduler } from "./scheduler.js";

describe("createPushScheduler", () => {
  it("pushes at a fixed N ÷ travel rate from a dt accumulator, whatever the frame rate", () => {
    for (const hz of [60, 120, 144]) {
      const s = createPushScheduler();
      let pushed = 0;
      for (let f = 0; f < hz * 7; f++) pushed += s.step(1 / hz, 240 / 7);
      expect(pushed).toBeGreaterThanOrEqual(239);
      expect(pushed).toBeLessThanOrEqual(240);
    }
  });

  it("carries a ring pushed at t = 0 to age 1 within ±2% of the travel time at 60 and 120 Hz", () => {
    for (const hz of [60, 120]) {
      for (const [N, travel] of [[120, 2], [240, 7], [400, 7], [400, 20]]) {
        const s = createPushScheduler();
        let pushes = 0; // pushes since our ring was the newest (i = 0)
        let t = 0;
        let age = 0;
        while (age < 1) {
          pushes += s.step(1 / hz, N / travel);
          t += 1 / hz;
          age = (pushes + s.frac) / (N - 1);
        }
        expect(Math.abs(t - travel) / travel, `${hz} Hz, N ${N}, ${travel} s`).toBeLessThanOrEqual(0.02);
      }
    }
  });

  it("keeps frac in [0, 1) and moves it continuously between pushes", () => {
    const s = createPushScheduler();
    let prev = 0;
    for (let f = 0; f < 600; f++) {
      const n = s.step(1 / 120, 240 / 7);
      expect(s.frac).toBeGreaterThanOrEqual(0);
      expect(s.frac).toBeLessThan(1);
      const moved = n + s.frac - prev;
      expect(moved).toBeCloseTo(240 / 7 / 120, 9); // same continuous advance every frame
      prev = s.frac;
    }
  });
});
