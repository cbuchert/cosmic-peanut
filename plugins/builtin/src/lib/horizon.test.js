// @ts-check
import { describe, expect, it } from "vitest";
import { createHorizon, createPeakEnvelope, F_MAX, F_MIN, HOLD, REST, shapeLevel } from "./horizon.js";

const SR = 48000;
const BINS = 1024;
const N = 96;

/** A spectrum with one loud bin at `hz` (nothing else). */
function tone(/** @type {number} */ hz, mag = 0.5) {
  const s = new Float32Array(BINS);
  s[Math.round((hz * 2 * BINS) / SR)] = mag;
  return s;
}

/** Run `frames` 60 Hz steps of the same spectrum; returns the last profile. */
function run(/** @type {Float32Array} */ spec, frames = 60, reactivity = 1) {
  const h = createHorizon(N);
  const out = new Float32Array(N);
  for (let f = 0; f < frames; f++) h.step(spec, SR, 1 / 60, reactivity, out);
  return out;
}

const argmax = (/** @type {Float32Array} */ a, from = 0, to = a.length) => {
  let best = from;
  for (let i = from; i < to; i++) if (a[i] > a[best]) best = i;
  return best;
};

describe("createHorizon: the mirrored log-frequency profile", () => {
  it("is symmetric, with a single loud bin's peak at its log-frequency x on both sides", () => {
    for (const hz of [80, 440, 3000]) {
      const out = run(tone(hz));
      for (let i = 0; i < N; i++) expect(out[i], `${hz} Hz texel ${i}`).toBeCloseTo(out[N - 1 - i], 6);
      const right = argmax(out, N / 2);
      const want = 0.5 + 0.5 * (Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)); // x across the range
      expect(Math.abs((right + 0.5) / N - want), `${hz} Hz`).toBeLessThan(1.5 / N);
      expect(out[right]).toBeGreaterThan(0.5);
    }
  });

  it("tapers to zero at the range's sides even when the whole spectrum is loud", () => {
    const loud = new Float32Array(BINS); // pink: level after the +3 dB/octave tilt
    for (let k = 1; k < BINS; k++) loud[k] = 0.3 / Math.sqrt((k * SR) / (2 * BINS) / 1000);
    const out = run(loud);
    expect(out[0]).toBe(0);
    expect(out[N - 1]).toBe(0);
    expect(out[1]).toBeLessThan(0.1);
    expect(out[N / 2]).toBeGreaterThan(0.5); // the middle stays deep
    for (let i = 1; i < N / 4; i++) expect(out[i], `texel ${i}`).toBeGreaterThanOrEqual(out[i - 1] - 0.02);
  });

  it("hangs deepest at the centre, like the cover's range, for an evenly loud spectrum", () => {
    const loud = new Float32Array(BINS);
    for (let k = 1; k < BINS; k++) loud[k] = 0.3 / Math.sqrt((k * SR) / (2 * BINS) / 1000);
    const out = run(loud);
    const centre = out[N / 2];
    const mid = out[N / 2 + N / 8];
    const outer = out[N / 2 + (3 * N) / 8 - 4];
    expect(centre).toBeGreaterThan(mid + 0.08);
    expect(mid).toBeGreaterThan(outer + 0.08);
  });
});

describe("createHorizon over time", () => {
  it("lets a peak linger after its tone stops, then sink to a small, symmetric rest ridge", () => {
    const h = createHorizon(N);
    const out = new Float32Array(N);
    const loud = tone(440);
    const quiet = new Float32Array(BINS);
    for (let f = 0; f < 30; f++) h.step(loud, SR, 1 / 60, 1, out);
    const i = argmax(out, N / 2);
    const top = out[i];
    for (let f = 0; f < 12; f++) h.step(quiet, SR, 1 / 60, 1, out);
    expect(out[i]).toBeGreaterThan(0.9 * top); // lingers
    for (let f = 0; f < 300; f++) h.step(quiet, SR, 1 / 60, 1, out);
    let max = 0;
    for (let k = 0; k < N; k++) {
      expect(out[k]).toBeCloseTo(out[N - 1 - k], 6);
      max = Math.max(max, out[k]);
    }
    expect(max).toBeLessThanOrEqual(REST + 1e-6);
    expect(max).toBeGreaterThan(REST * 0.3); // the cover's jagged range still hangs there in silence
    expect(out[0]).toBe(0);
  });
});

describe("createPeakEnvelope: fast attack, gentle peak-hold, slow release", () => {
  /** Level of one texel over time: `on` seconds of `x`, then silence. */
  function trace(/** @type {number} */ hz, /** @type {number} */ x, on = 0.5, total = 4) {
    const env = createPeakEnvelope(1);
    const inp = new Float32Array(1);
    const out = new Float32Array(1);
    /** @type {number[]} */ const t = [];
    for (let f = 0; f < total * hz; f++) {
      inp[0] = f / hz < on ? x : 0;
      env.step(inp, 1 / hz, out);
      t.push(out[0]);
    }
    return t;
  }

  it("rises within a few frames, lingers at the peak, then falls away", () => {
    const t = trace(60, 1);
    expect(t[3]).toBeGreaterThan(0.8); // attack
    const off = 30; // input drops at 0.5 s
    for (let f = off; f < off + HOLD * 60 - 1; f++) expect(t[f], `frame ${f}`).toBeGreaterThan(0.95); // hold
    expect(t[off + 60]).toBeLessThan(0.9); // then it falls ...
    expect(t[off + 60]).toBeGreaterThan(0.2); // ... slowly
    expect(t[t.length - 1]).toBeLessThan(0.05);
    for (let f = off + 1; f < t.length; f++) expect(t[f]).toBeLessThanOrEqual(t[f - 1] + 1e-9); // never rises in silence
  });

  it("is bounded 0-1 for wild input and the same at 60 and 120 Hz", () => {
    for (const x of [5, -3, NaN, Infinity]) for (const v of trace(60, x)) expect(v >= 0 && v <= 1, `${x}: ${v}`).toBe(true);
    const a = trace(60, 0.7);
    const b = trace(120, 0.7);
    for (let f = 0; f < a.length; f += 6) expect(Math.abs(a[f] - b[2 * f + 1]), `frame ${f}`).toBeLessThan(0.06);
  });
});

describe("shapeLevel: Reactivity as the range's contrast", () => {
  it("squares levels at 1 (loud frequencies stand out as peaks), is linear at 2 and flat at 0", () => {
    expect(shapeLevel(0.5, 1)).toBeCloseTo(0.25, 6);
    expect(shapeLevel(0.5, 2)).toBeCloseTo(0.5, 6);
    expect(shapeLevel(0.9, 0)).toBe(0);
    expect(shapeLevel(1, 1)).toBe(1);
    expect(shapeLevel(0.5, 1.5)).toBeGreaterThan(shapeLevel(0.5, 1));
    expect(shapeLevel(0.5, 0.5)).toBeLessThan(shapeLevel(0.5, 1));
    for (const [l, r] of [[7, 1], [-1, 2], [NaN, 1], [0.5, NaN], [0.5, 9]]) {
      const v = shapeLevel(l, r);
      expect(v >= 0 && v <= 1, `${l} ${r}`).toBe(true);
    }
  });
});
