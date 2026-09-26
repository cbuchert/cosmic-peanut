// @ts-check
import { describe, expect, it } from "vitest";
import { createPulse, pulseTarget, swell } from "./pulse.js";

describe("pulseTarget", () => {
  it("is clamp((bass − 1) × 1.2, 0, 1.5): only above-average bass moves anything", () => {
    expect(pulseTarget(0.4)).toBe(0);
    expect(pulseTarget(1)).toBe(0);
    expect(pulseTarget(1.5)).toBeCloseTo(0.6, 9);
    expect(pulseTarget(3)).toBe(1.5);
  });
});

/** A reusable fake audio frame carrying only what the pulse reads. */
function frame(bass = 1) {
  return { bass, waveform: new Float32Array(2048), sampleRate: 48000 };
}

describe("createPulse", () => {
  it("rises toward the target at 18/s and falls back at 4/s", () => {
    const p = createPulse();
    const a = frame(1 + 1 / 1.2); // target 1
    expect(p.step(a, 1 / 60)).toBeCloseTo(1 - Math.exp(-18 / 60), 9);
    for (let i = 0; i < 60; i++) p.step(a, 1 / 60);
    expect(p.value).toBeCloseTo(1, 3);
    a.bass = 0.5; // target 0
    expect(p.step(a, 1 / 60)).toBeCloseTo(Math.exp(-4 / 60), 3);
  });

  it("is frame-rate independent (two 120 Hz steps equal one 60 Hz step)", () => {
    const a = frame(2);
    const p60 = createPulse();
    const p120 = createPulse();
    p60.step(a, 1 / 60);
    p120.step(a, 1 / 120);
    expect(p120.step(a, 1 / 120)).toBeCloseTo(p60.value, 9);
  });

  it("swells 1–4% on a 120 BPM kick at defaults and settles within 0.5% before the next kick", () => {
    // Kick-like bass levels (1.0 = song average): a sharp hit decaying through each 0.5 s beat,
    // peaking at 2.6 (a typical four-on-the-floor kick) and 3.4 (hits the target clamp).
    const kicks = [
      (/** @type {number} */ ph) => 0.4 + 2.2 * Math.exp(-7 * ph),
      (/** @type {number} */ ph) => 0.4 + 3 * Math.exp(-7 * ph),
    ];
    for (const kick of kicks) {
      for (const hz of [60, 120]) {
        const p = createPulse();
        const a = frame();
        let peak = 0;
        let beforeNext = 0;
        for (let f = 0; f < hz * 8; f++) {
          const t = f / hz;
          const ph = (t * 2) % 1;
          a.bass = kick(ph);
          const s = swell(p.step(a, 1 / hz) * 0.35) - 1;
          if (t > 2) {
            peak = Math.max(peak, s);
            if (ph > 1 - 2 / hz) beforeNext = Math.max(beforeNext, s);
          }
        }
        expect(peak, `${hz} Hz peak`).toBeGreaterThanOrEqual(0.01);
        expect(peak, `${hz} Hz peak`).toBeLessThanOrEqual(0.04);
        expect(beforeNext, `${hz} Hz tail`).toBeLessThan(0.005);
      }
    }
  });

  it("never changes the radius at Pulse 0", () => {
    const p = createPulse();
    const a = frame();
    for (let f = 0; f < 600; f++) {
      a.bass = 0.3 + 3 * Math.exp(-7 * ((f / 30) % 1));
      expect(swell(p.step(a, 1 / 60) * 0)).toBe(1);
    }
  });

  it("estimates bass from the waveform when the host gives no bass level", () => {
    const p = createPulse();
    const a = { waveform: new Float32Array(2048), sampleRate: 48000 };
    let n = 0;
    /** @param {number} amp @param {number} hz */
    const fill = (amp, hz) => {
      for (let i = 0; i < 2048; i++) a.waveform[i] = amp * Math.sin((2 * Math.PI * hz * (n + i)) / 48000);
      n += 800;
    };
    for (let f = 0; f < 60 * 6; f++) {
      fill(0.2, 60);
      p.step(a, 1 / 60);
    }
    expect(p.value).toBeLessThan(0.05); // steady bass is "average": no pulse
    for (let f = 0; f < 6; f++) {
      fill(0.6, 60);
      p.step(a, 1 / 60);
    }
    expect(p.value).toBeGreaterThan(0.5); // bass tripled: a clear swell
  });

  it("ignores treble in the fallback estimate (it low-passes at about 140 Hz)", () => {
    const p = createPulse();
    const a = { waveform: new Float32Array(2048), sampleRate: 48000 };
    for (let f = 0; f < 60 * 6; f++) {
      for (let i = 0; i < 2048; i++) a.waveform[i] = 0.2 * Math.sin(i * 0.008) + (f > 350 ? 0.8 * Math.sin(i * 0.9) : 0);
      p.step(a, 1 / 60);
    }
    expect(p.value).toBeLessThan(0.15);
  });
});
