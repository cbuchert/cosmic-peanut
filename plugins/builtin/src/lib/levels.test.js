// @ts-check
import { describe, expect, it } from "vitest";
import { groupBands, PEAK_HOLD, smoothLevels, updatePeaks } from "./levels.js";

const DT = 1 / 60;
const ramp = Float32Array.from({ length: 64 }, (_, i) => i / 63);

describe("groupBands", () => {
  it("copies all 64 bands when count is 64", () => {
    const out = new Float32Array(64);
    groupBands(ramp, 64, out);
    expect(out).toEqual(ramp);
  });

  it("takes the loudest band of each group", () => {
    const out = new Float32Array(16);
    groupBands(ramp, 16, out);
    expect(out[0]).toBeCloseTo(3 / 63);
    expect(out[15]).toBeCloseTo(1);
  });

  it("writes only `count` entries into a larger buffer", () => {
    const out = new Float32Array(64).fill(-1);
    groupBands(ramp, 32, out);
    expect(out[31]).toBeCloseTo(1);
    expect(out[32]).toBe(-1);
  });
});

describe("smoothLevels", () => {
  it("follows the target exactly with smoothing 0", () => {
    const lv = new Float32Array([1, 0]);
    smoothLevels(lv, new Float32Array([0, 1]), 2, 0, DT);
    expect(Array.from(lv)).toEqual([0, 1]);
  });

  it("rises instantly and falls by the smoothing factor per 60 Hz frame", () => {
    const lv = new Float32Array([1, 0]);
    smoothLevels(lv, new Float32Array([0, 0.8]), 2, 0.5, DT);
    expect(lv[0]).toBeCloseTo(0.5);
    expect(lv[1]).toBeCloseTo(0.8);
  });

  it("is frame-rate independent", () => {
    const a = new Float32Array([1]);
    const b = new Float32Array([1]);
    const zero = new Float32Array([0]);
    smoothLevels(a, zero, 1, 0.5, 2 * DT);
    smoothLevels(b, zero, 1, 0.5, DT);
    smoothLevels(b, zero, 1, 0.5, DT);
    expect(a[0]).toBeCloseTo(b[0]);
  });
});

describe("updatePeaks", () => {
  it("jumps to a new high, holds, then falls but never below the level", () => {
    const peaks = new Float32Array(1);
    const hold = new Float32Array(1);
    const vel = new Float32Array(1);
    updatePeaks(peaks, hold, vel, new Float32Array([0.9]), 1, DT);
    expect(peaks[0]).toBeCloseTo(0.9);

    const low = new Float32Array([0.2]);
    let t = 0;
    while (t < PEAK_HOLD - 2 * DT) {
      updatePeaks(peaks, hold, vel, low, 1, DT);
      t += DT;
    }
    expect(peaks[0]).toBeCloseTo(0.9);
    for (let i = 0; i < 120; i++) updatePeaks(peaks, hold, vel, low, 1, DT);
    expect(peaks[0]).toBeCloseTo(0.2);
  });
});
