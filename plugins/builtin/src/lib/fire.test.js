// @ts-check
import { describe, expect, it } from "vitest";
import { createAutoGain, resampleSeed } from "./fire.js";

const DT = 1 / 60;

describe("resampleSeed", () => {
  it("point-samples every texel by linear interpolation between the two nearest samples", () => {
    const n = 2048;
    const wave = new Float32Array(n);
    for (let i = 0; i < n; i++) wave[i] = Math.sin(i * 0.37) * (i % 7 === 0 ? -1 : 0.6);
    const S = 256;
    const mag = new Float32Array(S);
    const signed = new Float32Array(S);
    resampleSeed(wave, mag, signed);
    for (let i = 0; i < S; i++) {
      const x = (i * (n - 1)) / (S - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(n - 1, i0 + 1);
      const f = x - i0;
      const v = wave[i0] + (wave[i1] - wave[i0]) * f;
      const m = Math.abs(wave[i0]) + (Math.abs(wave[i1]) - Math.abs(wave[i0])) * f;
      expect(signed[i]).toBeCloseTo(v, 6);
      expect(mag[i]).toBeCloseTo(m, 6);
    }
  });

  it("handles other lengths: shorter arrays span their whole length, longer ones use the newest 2,048", () => {
    const S = 64;
    const mag = new Float32Array(S);
    const signed = new Float32Array(S);
    const short = new Float32Array(1000).map((_, i) => i / 999);
    resampleSeed(short, mag, signed);
    expect(signed[0]).toBe(0);
    expect(signed[S - 1]).toBeCloseTo(1, 6);
    const long = new Float32Array(4096).map((_, i) => (i < 2048 ? 5 : (i - 2048) / 2047));
    resampleSeed(long, mag, signed);
    expect(signed[0]).toBe(0);
    expect(signed[S - 1]).toBeCloseTo(1, 6);
    expect(Math.max(...signed)).toBeLessThanOrEqual(1);
  });

  it("writes zeros for an empty waveform and a constant for a single sample", () => {
    const mag = new Float32Array(8).fill(9);
    const signed = new Float32Array(8).fill(9);
    resampleSeed(new Float32Array(0), mag, signed);
    expect([...mag, ...signed].every((v) => v === 0)).toBe(true);
    resampleSeed(new Float32Array([-0.5]), mag, signed);
    expect([...mag].every((v) => v === 0.5)).toBe(true);
    expect([...signed].every((v) => v === -0.5)).toBe(true);
  });
});

describe("createAutoGain", () => {
  it("brings a steady level to the target", () => {
    for (const level of [0.1, 0.3, 0.9]) {
      const g = createAutoGain();
      let gain = 0;
      for (let i = 0; i < 600; i++) gain = g.step(level, DT);
      expect(gain * level).toBeCloseTo(g.target, 2);
    }
  });

  it("keeps silence (and quiet noise) near zero: the gain is capped", () => {
    const g = createAutoGain({ maxGain: 8 });
    const wave = new Float32Array(2048).map((_, i) => 1e-4 * Math.sin(i));
    const mag = new Float32Array(256);
    const signed = new Float32Array(256);
    let gain = 0;
    for (let i = 0; i < 600; i++) gain = g.step(1e-4, DT);
    expect(gain).toBeLessThanOrEqual(8);
    resampleSeed(wave, mag, signed);
    expect(Math.max(...mag) * gain).toBeLessThan(0.002);
  });

  it("drops at once on a loud hit and recovers only slowly afterwards", () => {
    const g = createAutoGain({ release: 4 });
    for (let i = 0; i < 600; i++) g.step(0.1, DT);
    expect(g.step(0.9, DT) * 0.9).toBeCloseTo(g.target, 5);
    let gain = 0;
    for (let i = 0; i < 60; i++) gain = g.step(0.1, DT);
    expect(gain * 0.1).toBeLessThan(0.15); // one second later the quiet part is still quiet
  });
});
