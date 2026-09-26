// @ts-check
import { describe, expect, it } from "vitest";
import { advanceScroll, bandAt, centralEnvelope, createRing, resizeRing, ringPush, ringRow } from "./ridges.js";

const ramp = Float32Array.from({ length: 64 }, (_, i) => i / 63);

describe("centralEnvelope", () => {
  it("is 1 in the middle, 0 outside the central band, and symmetric", () => {
    const env = new Float32Array(161);
    centralEnvelope(env, 0.25);
    expect(env[80]).toBeCloseTo(1);
    expect(env[0]).toBe(0);
    expect(env[160]).toBe(0);
    expect(env[20]).toBe(0); // x = 0.125, outside 0.5 ± 0.25
    for (let i = 0; i < 161; i++) expect(env[i]).toBeCloseTo(env[160 - i]);
    expect(env[60]).toBeGreaterThan(0.2); // x = 0.375: inside, on the slope
    expect(env[60]).toBeLessThan(0.9);
  });
});

describe("bandAt", () => {
  it("interpolates linearly between neighbouring bands", () => {
    expect(bandAt(ramp, 20)).toBeCloseTo(20 / 63);
    expect(bandAt(ramp, 20.25)).toBeCloseTo(20.25 / 63);
  });

  it("clamps outside 0–63", () => {
    expect(bandAt(ramp, -3)).toBeCloseTo(0);
    expect(bandAt(ramp, 70)).toBeCloseTo(1);
  });
});

describe("advanceScroll", () => {
  /** Scroll position in lines (pushed + fraction) after each frame at `hz`. */
  function positions(/** @type {number} */ hz, /** @type {number} */ seconds, rate = 10) {
    const s = { frac: 0 };
    let pushed = 0;
    const out = [];
    for (let f = 0; f < Math.round(seconds * hz); f++) {
      pushed += advanceScroll(s, 1 / hz, rate, 1000);
      expect(s.frac).toBeGreaterThanOrEqual(0);
      expect(s.frac).toBeLessThan(1);
      out.push(pushed + s.frac);
    }
    return out;
  }

  it("pushes `rate` lines per second", () => {
    const p = positions(60, 3);
    expect(p[p.length - 1]).toBeCloseTo(30, 6);
  });

  it("moves the same distance every frame at 60 and at 120 Hz: continuous, no stepping", () => {
    for (const hz of [60, 120]) {
      const p = positions(hz, 2);
      for (let i = 1; i < p.length; i++) expect(p[i] - p[i - 1]).toBeCloseTo(10 / hz, 6);
    }
    expect(positions(120, 2)[239]).toBeCloseTo(positions(60, 2)[119], 6);
  });

  it("never pushes more than `max` lines in one step", () => {
    const s = { frac: 0 };
    expect(advanceScroll(s, 100, 10, 80)).toBe(80);
    expect(s.frac).toBeLessThan(1);
  });
});

describe("ring history", () => {
  /** Push rows whose every value is `v`. */
  function push(/** @type {ReturnType<typeof createRing>} */ r, /** @type {number} */ v) {
    const o = ringPush(r);
    r.data.fill(v, o, o + r.points);
  }

  it("starts as `lines` flat rows", () => {
    const r = createRing(4, 3);
    expect(r.data.length).toBe(12);
    for (let a = 0; a < 4; a++) expect(r.data[ringRow(r, a)]).toBe(0);
  });

  it("returns rows newest first and drops the oldest when full", () => {
    const r = createRing(3, 2);
    for (const v of [1, 2, 3, 4]) push(r, v);
    expect([0, 1, 2].map((a) => r.data[ringRow(r, a)])).toEqual([4, 3, 2]);
    expect(r.data[ringRow(r, 0) + 1]).toBe(4);
  });

  it("resizes keeping the newest rows in order, padding with flat rows", () => {
    const r = createRing(3, 2);
    for (const v of [1, 2, 3, 4]) push(r, v);
    const small = resizeRing(r, 2);
    expect([0, 1].map((a) => small.data[ringRow(small, a)])).toEqual([4, 3]);
    const big = resizeRing(r, 5);
    expect([0, 1, 2, 3, 4].map((a) => big.data[ringRow(big, a)])).toEqual([4, 3, 2, 0, 0]);
    push(big, 5);
    expect(big.data[ringRow(big, 0)]).toBe(5);
    expect(big.data[ringRow(big, 1)]).toBe(4);
  });
});
