// @ts-check
import { describe, expect, it } from "vitest";
import { createAutoGain, createDrive, createEnvelope, createStepper, resampleSeed } from "./fire.js";

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

/** Run an envelope on `signal(t)` at `hz` for `seconds`; returns the output samples. */
function runEnv(/** @type {ReturnType<typeof createEnvelope>} */ env, /** @type {(t: number) => number} */ signal, hz = 60, seconds = 1) {
  const out = [];
  for (let i = 0; i < seconds * hz; i++) out.push(env.step(signal(i / hz), 1 / hz));
  return out;
}

describe("createEnvelope", () => {
  it("rises and falls with bounded, separate time constants", () => {
    const env = createEnvelope(0.05, 0.4);
    const up = env.step(1, DT);
    expect(up).toBeGreaterThan(0);
    expect(up).toBeCloseTo(1 - Math.exp(-DT / 0.05), 6);
    for (let i = 0; i < 60; i++) env.step(1, DT);
    const down = env.step(0, DT);
    expect(down).toBeCloseTo(env.value, 9);
    expect(1 - down).toBeCloseTo(1 - Math.exp(-DT / 0.4), 3);
  });
});

/** @param {number} bass @param {boolean} onset @param {number} [onsetStrength] */
const au = (bass, onset, onsetStrength = 0.8) => ({ bass, onset, onsetStrength });

describe("createDrive", () => {
  it("an onset throws a flare with a bounded attack that dies away", () => {
    const d = createDrive();
    d.step(au(1, true), DT, false);
    const first = d.flare;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.6);
    let peak = first;
    for (let i = 0; i < 90; i++) {
      d.step(au(1, false), DT, false);
      peak = Math.max(peak, d.flare);
    }
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThanOrEqual(1);
    expect(d.flare).toBeLessThan(0.05);
  });

  it("bass stokes the fire: loud bass drives stoke toward 1, quiet bass lets it fall to 0", () => {
    const d = createDrive();
    d.step(au(2, false), DT, false);
    expect(d.stoke).toBeLessThan(0.5); // bounded attack
    for (let i = 0; i < 60; i++) d.step(au(2, false), DT, false);
    expect(d.stoke).toBeGreaterThan(0.9);
    expect(d.stoke).toBeLessThanOrEqual(1);
    for (let i = 0; i < 120; i++) d.step(au(0.5, false), DT, false);
    expect(d.stoke).toBeLessThan(0.02);
  });

  it("with reduceFlashing, a 10 Hz strobe of onsets and bass swings the boost at most 3 times a second", () => {
    for (const reduce of [false, true]) {
      const d = createDrive();
      const out = [];
      for (let i = 0; i < 240; i++) {
        const on = i % 6 === 0;
        d.step(au(on ? 2.5 : 0.5, on, 1), DT, reduce);
        out.push(d.boost);
      }
      const n = maxFlashesPerSecond(out, 0.05);
      if (reduce) expect(n).toBeLessThanOrEqual(3);
      else expect(n).toBeGreaterThan(3); // the check can see flashes at all
    }
  });

  it("behaves the same at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const sample = (hz) => {
      const d = createDrive();
      const out = [];
      for (let i = 0; i < hz * 2; i++) {
        const t = i / hz;
        d.step(au(1 + Math.sin(t * 5), Math.floor(t * 2) !== Math.floor((t - 1 / hz) * 2) && i > 0), 1 / hz, true);
        if (i % (hz / 10) === hz / 20) out.push(d.boost); // between onset frames
      }
      return out;
    };
    const a = sample(60);
    const b = sample(120);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.08);
  });
});

describe("createStepper", () => {
  it("runs the same number of sim steps per second at 60 and 120 Hz", () => {
    for (const hz of [60, 120, 144, 50]) {
      const st = createStepper(120, 4);
      let n = 0;
      for (let i = 0; i < hz * 10; i++) n += st.step(1 / hz);
      expect(Math.abs(n - 1200)).toBeLessThanOrEqual(1);
    }
  });

  it("caps the steps per frame and drops the backlog after a stall", () => {
    const st = createStepper(120, 4);
    expect(st.step(0.1)).toBe(4);
    expect(st.step(1 / 60)).toBe(2);
  });

  it("gives an even 2 steps every frame at exactly 60 Hz", () => {
    const st = createStepper(120, 4);
    const counts = new Set();
    for (let i = 0; i < 600; i++) counts.add(st.step(1 / 60));
    expect([...counts]).toEqual([2]);
  });
});

/** WCAG-style flash count: rises of ≥ threshold after a fall of ≥ threshold; max in any 1 s (60 Hz). */
function maxFlashesPerSecond(/** @type {number[]} */ v, /** @type {number} */ threshold) {
  /** @type {number[]} */
  const starts = [];
  let rising = false;
  let lo = v[0];
  let hi = v[0];
  for (let i = 1; i < v.length; i++) {
    if (!rising) {
      lo = Math.min(lo, v[i]);
      if (v[i] - lo >= threshold) {
        starts.push(i / 60);
        rising = true;
        hi = v[i];
      }
    } else {
      hi = Math.max(hi, v[i]);
      if (hi - v[i] >= threshold) {
        rising = false;
        lo = v[i];
      }
    }
  }
  let best = 0;
  for (let i = 0; i < starts.length; i++) {
    let n = 0;
    for (let j = i; j < starts.length && starts[j] - starts[i] < 1; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}
