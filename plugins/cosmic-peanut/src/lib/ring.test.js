// @ts-check
import { describe, expect, it } from "vitest";
import { createRingBuilder, findTrigger, finishRing, nextPeak, resample, windowLength } from "./ring.js";

describe("windowLength", () => {
  it("spans 1024 samples at Detail 0 and 192 at Detail 1", () => {
    expect(windowLength(0)).toBe(1024);
    expect(windowLength(1)).toBe(192);
    expect(windowLength(0.7)).toBe(Math.round(1024 - 832 * 0.7));
  });
});

describe("findTrigger", () => {
  it("starts at the first rising zero crossing", () => {
    const wave = new Float32Array(2048).fill(0.5);
    wave.fill(-0.3, 0, 100); // falls through zero at 0, rises through zero at 100
    wave.fill(-0.2, 300, 310);
    expect(findTrigger(wave, 512)).toBe(100);
  });

  it("starts at 0 when fewer than 2W samples are available", () => {
    const wave = new Float32Array(1000).fill(0.5);
    wave.fill(-0.3, 0, 100);
    expect(findTrigger(wave, 512)).toBe(0);
  });
});

/** Deterministic white noise in −1..1. @param {number} n */
function noise(n, seed = 7) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    out[i] = (seed / 2147483647) * 2 - 1;
  }
  return out;
}

describe("resample", () => {
  it("point-samples with linear interpolation and no averaging (every sample is kept)", () => {
    const wave = noise(2048);
    const out = new Float32Array(512);
    const W = windowLength(1); // 192 samples → 512 points: every source sample lands in the ring
    resample(wave, 37, W, out);
    for (let j = 0; j < 512; j++) {
      const x = 37 + (j * W) / 512;
      const i0 = Math.floor(x);
      const f = x - i0;
      expect(out[j]).toBeCloseTo(wave[i0] * (1 - f) + wave[i0 + 1] * f, 6);
    }
    // Regression: each source sample at an integer position appears exactly.
    for (let k = 0; k < W; k += 3) expect(out[(k * 512) / W]).toBeCloseTo(wave[37 + k], 6);
  });
});

describe("auto-gain", () => {
  it("jumps to a louder peak and decays by × 0.992 per ring otherwise", () => {
    expect(nextPeak(0.1, 0.5)).toBe(0.5);
    expect(nextPeak(0.5, 0.1)).toBeCloseTo(0.5 * 0.992, 9);
    expect(nextPeak(0.5, 0.499)).toBe(0.499); // the decay never undercuts this ring's own peak
  });

  it("divides by the tracked peak, floored at 0.02, and clamps to ±1.5", () => {
    const out = new Float32Array(512);
    out[256] = 0.01;
    out[257] = -0.2;
    finishRing(out, 0.001);
    expect(out[256]).toBeCloseTo(0.5, 6); // 0.01 / 0.02
    expect(out[257]).toBe(-1.5); // −10 clamped
    out[256] = 0.3;
    finishRing(out, 0.6);
    expect(out[256]).toBeCloseTo(0.5, 6);
  });
});

describe("seam taper", () => {
  it("eases the first and last 8% of points to zero with a raised cosine", () => {
    const M = 512;
    const T = Math.floor(M * 0.08); // 40
    const out = new Float32Array(M).fill(1);
    finishRing(out, 1);
    expect(out[0]).toBe(0);
    expect(out[M - 1]).toBe(0);
    expect(out[T / 2]).toBeCloseTo(0.5, 6);
    expect(out[M - 1 - T / 2]).toBeCloseTo(0.5, 6);
    expect(out[10]).toBeCloseTo(0.5 - 0.5 * Math.cos((Math.PI * 10) / T), 6);
    for (let j = T; j <= M - 1 - T; j++) expect(out[j]).toBe(1);
  });
});

/** Newest 2048 samples of a 440 Hz sine ending at sample `end` (48 kHz). @param {number} end */
function sine440(end, out = new Float32Array(2048)) {
  for (let i = 0; i < out.length; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * 440 * (end - out.length + i)) / 48000);
  return out;
}

describe("createRingBuilder", () => {
  it("turns a 440 Hz sine into the same ring every time (the trigger works)", () => {
    const b = createRingBuilder(512);
    const wave = new Float32Array(2048);
    const first = Float32Array.from(b.build(sine440(10000, wave), 0.7));
    for (const end of [10512, 11024, 11536, 30001]) {
      const ring = b.build(sine440(end, wave), 0.7);
      for (let j = 0; j < 512; j++) expect(ring[j]).toBeCloseTo(first[j], 2);
    }
  });

  it("reuses its output array (no allocation per ring)", () => {
    const b = createRingBuilder(512);
    const wave = noise(2048);
    expect(b.build(wave, 0.7)).toBe(b.ring);
    expect(b.build(wave, 0.2)).toBe(b.ring);
  });

  it("works on a waveform shorter than the window, without the trigger", () => {
    const b = createRingBuilder(512);
    const wave = noise(300);
    const ring = b.build(wave, 0); // wants 1024 samples, gets 300
    expect(ring.every(Number.isFinite)).toBe(true);
    expect(Math.max(...ring.map(Math.abs))).toBeGreaterThan(0.5);
  });

  it("keeps a slowly decaying gain: a quieter ring after a loud one stays quieter", () => {
    const b = createRingBuilder(512);
    const loud = sine440(10000);
    b.build(loud, 0.7);
    const quiet = loud.map((v) => v * 0.5);
    const peak = Math.max(...b.build(quiet, 0.7).map(Math.abs));
    expect(peak).toBeCloseTo(0.5 / 0.992, 2);
  });
});
