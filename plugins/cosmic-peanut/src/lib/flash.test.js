// @ts-check
import { describe, expect, it } from "vitest";
import { createFlashLimiter } from "./flash.js";

const DT = 1 / 60;

/**
 * Times of flashes (when the rise completes): a rise of at least `threshold` from the lowest point since the last
 * fall of at least `threshold` (WCAG counts a flash as such a pair of opposing changes).
 * @param {number[]} values
 * @param {number} threshold
 */
function flashStarts(values, threshold = 0.1) {
  /** @type {number[]} */
  const starts = [];
  let rising = false;
  let lo = values[0];
  let hi = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!rising) {
      if (v < lo) lo = v;
      if (v - lo >= threshold) {
        starts.push(i * DT);
        rising = true;
        hi = v;
      }
    } else {
      hi = Math.max(hi, v);
      if (hi - v >= threshold) {
        rising = false;
        lo = v;
      }
    }
  }
  return starts;
}

/** Most flashes in any 1-second window. */
function maxPerSecond(/** @type {number[]} */ starts) {
  let best = 0;
  for (let i = 0; i < starts.length; i++) {
    let n = 0;
    for (let j = i; j < starts.length && starts[j] - starts[i] < 1; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** @param {(t: number) => number} signal @param {boolean} enabled @param {number} seconds */
function run(signal, enabled, seconds = 4) {
  const lim = createFlashLimiter();
  const out = [];
  for (let i = 0; i < seconds * 60; i++) out.push(lim.step(signal(i * DT), DT, enabled));
  return out;
}

const square10Hz = (/** @type {number} */ t) => (Math.floor(t * 20) % 2 === 0 ? 1 : 0);

describe("createFlashLimiter", () => {
  it("passes the signal through unchanged when disabled", () => {
    const out = run(square10Hz, false);
    expect(out.slice(0, 8)).toEqual([1, 1, 1, 0, 0, 0, 1, 1]);
    expect(maxPerSecond(flashStarts(out))).toBeGreaterThan(3);
  });

  it("caps a 10 Hz full-screen strobe at 3 flashes per second when enabled", () => {
    const out = run(square10Hz, true);
    const starts = flashStarts(out);
    expect(starts.length).toBeGreaterThan(4); // still reacts
    expect(maxPerSecond(starts)).toBeLessThanOrEqual(3);
  });

  it("caps random onset-driven pulses too", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let env = 0;
    const lim = createFlashLimiter();
    const out = [];
    for (let i = 0; i < 600; i++) {
      env = rnd() < 0.2 ? 1 : env * 0.8;
      out.push(lim.step(env, DT, true));
    }
    expect(maxPerSecond(flashStarts(out))).toBeLessThanOrEqual(3);
  });

  it("lets an isolated flash through immediately", () => {
    const lim = createFlashLimiter();
    expect(lim.step(0, DT, true)).toBe(0);
    expect(lim.step(1, DT, true)).toBe(1);
  });

  it("follows slow changes (under 3 per second) without holding", () => {
    const slow = (/** @type {number} */ t) => 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    const on = run(slow, true);
    const off = run(slow, false);
    for (let i = 0; i < on.length; i++) expect(on[i]).toBeCloseTo(off[i], 6);
  });
});
