import { describe, it, expect } from "vitest";
import { createQualityController } from "./quality.js";

const BUDGET = 1000 / 60;

/**
 * Feed frames of `frameMs` for `durationMs` on a fake clock. Returns the final scale.
 * @param {ReturnType<typeof createQualityController>} q
 * @param {{ t: number }} clock
 * @param {number} frameMs
 * @param {number} durationMs
 */
function run(q, clock, frameMs, durationMs) {
  const end = clock.t + durationMs;
  let s = q.scale;
  while (clock.t < end) {
    clock.t += frameMs;
    s = q.sample(clock.t, frameMs);
  }
  return s;
}

describe("quality controller", () => {
  it("stays at max while frames fit the budget", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    expect(run(q, { t: 0 }, BUDGET, 30_000)).toBe(1);
  });

  it("lowers by 0.1 only after 2 s over budget", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    const clock = { t: 0 };
    expect(run(q, clock, 30, 1800)).toBe(1);
    expect(run(q, clock, 30, 600)).toBeCloseTo(0.9);
  });

  it("keeps lowering in 10% steps down to 0.5", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    expect(run(q, { t: 0 }, 40, 60_000)).toBeCloseTo(0.5);
  });

  it("ignores a short spike", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    const clock = { t: 0 };
    run(q, clock, BUDGET, 1000);
    run(q, clock, 100, 500);
    expect(run(q, clock, BUDGET, 5000)).toBe(1);
  });

  it("raises again after 10 s of headroom, up to max", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    const clock = { t: 0 };
    run(q, clock, 30, 4500);
    expect(q.scale).toBeCloseTo(0.8);
    expect(run(q, clock, BUDGET, 9000)).toBeCloseTo(0.8);
    expect(run(q, clock, BUDGET, 1500)).toBeCloseTo(0.9);
    expect(run(q, clock, BUDGET, 60_000)).toBe(1);
  });

  it("does nothing when disabled (quality not auto) and reports max", () => {
    const q = createQualityController({ budgetMs: BUDGET, max: 0.8 });
    q.enabled = false;
    expect(run(q, { t: 0 }, 40, 10_000)).toBe(0.8);
  });

  it("reset() returns to max and restarts the timers", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    const clock = { t: 0 };
    run(q, clock, 40, 2500);
    q.reset();
    expect(q.scale).toBe(1);
    expect(run(q, clock, 40, 1500)).toBe(1);
  });

  it("setMax clamps the current scale and the ceiling", () => {
    const q = createQualityController({ budgetMs: BUDGET });
    q.setMax(0.7);
    expect(q.scale).toBeCloseTo(0.7);
    expect(run(q, { t: 0 }, BUDGET, 30_000)).toBeCloseTo(0.7);
  });
});
