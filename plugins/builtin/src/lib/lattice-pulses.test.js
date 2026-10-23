// @ts-check
import { describe, expect, it } from "vitest";
import { PULSE_CAP, REACH, REDUCED_LEVEL, createPulses } from "./lattice-pulses.js";

describe("createPulses", () => {
  it("launches a pulse from the lattice node nearest the given point, relative to the origin", () => {
    const p = createPulses();
    p.launch(new Float64Array([102.4, -3.4, 7.6]), 1, false, 0.5);
    p.step(0.01, new Float64Array([100, -5, 5]));
    expect(Array.from(p.data.subarray(0, 3))).toEqual([2, 2, 3]);
    expect(p.amp[0]).toBeGreaterThan(0);
  });

  it("eases each pulse in over 80 ms and out by 0.9 beat while its front runs REACH cells", () => {
    const p = createPulses();
    const origin = new Float64Array(3);
    p.launch(origin, 0.8, false, 0.5); // 120 BPM: gone by 0.45 s
    /** @type {[number, number, number][]} */
    const trace = [];
    let prev = 0;
    let maxStep = 0;
    for (let f = 1; f <= 240 * 0.6; f++) {
      p.step(1 / 240, origin);
      trace.push([f / 240, p.amp[0], p.data[3]]);
      maxStep = Math.max(maxStep, Math.abs(p.amp[0] - prev));
      prev = p.amp[0];
    }
    const at = (/** @type {number} */ s) => /** @type {[number, number, number]} */ (trace.find(([t]) => t >= s - 1e-9));
    expect(at(0.04)[1]).toBeGreaterThan(0.8 * 0.4);
    expect(at(0.04)[1]).toBeLessThan(0.8 * 0.6);
    expect(at(0.08)[1]).toBeCloseTo(0.8, 2);
    expect(at(0.25)[1]).toBeGreaterThan(0.1);
    expect(at(0.25)[1]).toBeLessThan(0.75);
    expect(at(0.46)[1]).toBe(0);
    // The front moves out steadily, REACH cells over the pulse's life.
    expect(at(0.225)[2]).toBeCloseTo(REACH / 2, 1);
    expect(at(0.45)[2]).toBeCloseTo(REACH, 1);
    expect(maxStep).toBeLessThan(0.07);
  });

  it("recycles the oldest slot when the pool is full", () => {
    const p = createPulses();
    const origin = new Float64Array(3);
    for (let k = 0; k <= PULSE_CAP; k++) {
      p.launch(new Float64Array([k, 0, 0]), 1, false, 4); // long lives: all still in flight
      p.step(0.01, origin);
    }
    const xs = Array.from({ length: PULSE_CAP }, (_, i) => p.data[i * 4]).sort((a, b) => a - b);
    expect(xs).toEqual(Array.from({ length: PULSE_CAP }, (_, i) => i + 1)); // node 0 was replaced
    for (let i = 0; i < PULSE_CAP; i++) expect(p.amp[i]).toBeGreaterThan(0);
  });

  it("with Reduce flashing, launches at most 3 a second, much dimmer", () => {
    const p = createPulses();
    const origin = new Float64Array(3);
    let launched = 0;
    let peak = 0;
    for (let f = 0; f < 240 * 2; f++) {
      // A beat every 0.1 s (a fast fill).
      if (f % 24 === 0) launched += p.launch(origin, 1, true, 0.1) ? 1 : 0;
      p.step(1 / 240, origin);
      for (let i = 0; i < PULSE_CAP; i++) peak = Math.max(peak, p.amp[i]);
    }
    expect(launched).toBeLessThanOrEqual(6);
    expect(launched).toBeGreaterThanOrEqual(5);
    expect(peak).toBeCloseTo(REDUCED_LEVEL, 2);
    expect(REDUCED_LEVEL).toBeLessThanOrEqual(0.35);
    // Off: every beat launches, at full level.
    const q = createPulses();
    let all = 0;
    for (let f = 0; f < 240; f++) {
      if (f % 24 === 0) all += q.launch(origin, 1, false, 0.1) ? 1 : 0;
      q.step(1 / 240, origin);
    }
    expect(all).toBe(10);
  });

  it("travels `reach` × REACH cells (Reduce motion shortens it)", () => {
    const p = createPulses();
    const origin = new Float64Array(3);
    p.launch(origin, 1, false, 0.5, 0.3);
    for (let f = 0; f < 240 * 0.45; f++) p.step(1 / 240, origin);
    expect(p.data[3]).toBeCloseTo(0.3 * REACH, 1);
  });

  it("also lists the live pulses first (`live`, `liveCount`), for shaders that loop only over those", () => {
    const p = createPulses();
    const origin = new Float64Array([1, 0, 0]);
    expect(p.step(0.01, origin).liveCount).toBe(0);
    p.launch(new Float64Array([3, 0, 0]), 1, false, 0.5); // slot 0, dies at 0.45 s
    p.step(0.3, origin);
    p.launch(new Float64Array([5, 1, 0]), 0.5, false, 4); // slot 1
    p.step(0.2, origin); // slot 0 now dead
    expect(p.liveCount).toBe(1);
    expect(Array.from(p.live.subarray(0, 4))).toEqual(Array.from(p.data.subarray(4, 8)));
    expect(p.liveAmp[0]).toBe(p.amp[1]);
    expect(p.liveAmp[0]).toBeGreaterThan(0);
  });
});
