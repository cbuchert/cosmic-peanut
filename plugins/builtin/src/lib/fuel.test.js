// @ts-check
import { describe, expect, it } from "vitest";
import { createAttacks, createBandGain, mapMirrored, shapeLevel } from "./fuel.js";

const DT = 1 / 60;

describe("mapMirrored", () => {
  it("puts the bass at the centre and the highs at both edges, symmetrically", () => {
    const bands = new Float32Array(64).map((_, i) => i / 63); // level = band position
    const out = new Float32Array(256);
    mapMirrored(bands, out);
    expect(out[127]).toBeLessThan(0.02);
    expect(out[128]).toBeLessThan(0.02);
    expect(out[0]).toBeGreaterThan(0.98);
    expect(out[255]).toBeGreaterThan(0.98);
    for (let i = 0; i < 128; i++) {
      expect(out[i]).toBeCloseTo(out[255 - i], 6);
      if (i > 0) expect(out[i]).toBeLessThanOrEqual(out[i - 1]); // falls toward the centre
    }
  });
});

describe("shapeLevel", () => {
  it("gates the noise floor and expands: steeper than linear, monotonic, 0–1", () => {
    expect(shapeLevel(0.1, 1)).toBe(0); // under the gate
    expect(shapeLevel(1, 1)).toBeCloseTo(1, 6);
    expect(shapeLevel(0.5, 1)).toBeLessThan(0.35); // expanded well below linear
    let prev = 0;
    for (let n = 0; n <= 1.0001; n += 0.01) {
      const v = shapeLevel(n, 1);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(shapeLevel(2, 1)).toBeCloseTo(1, 6); // clamped
  });

  it("reactivity sets the drama: 0 is linear and ungated, 2 gates and expands harder", () => {
    for (const n of [0.1, 0.4, 0.7]) {
      expect(shapeLevel(n, 0)).toBeCloseTo(n, 6);
    }
    for (const n of [0.4, 0.7]) expect(shapeLevel(n, 2)).toBeLessThan(shapeLevel(n, 1));
  });
});

/** Run a band gain on a fixed spectrum for `seconds`; returns its last output. */
function settle(/** @type {ReturnType<typeof createBandGain>} */ g, /** @type {Float32Array} */ bands, seconds, dt = DT) {
  const out = new Float32Array(bands.length);
  for (let t = 0; t < seconds; t += dt) g.step(bands, dt, out);
  return out;
}

describe("createBandGain", () => {
  it("loud bands normalise high and quiet bands stay near the floor once shaped", () => {
    const bands = new Float32Array(64).map((_, i) => (i < 16 ? 0.8 : 0.08));
    const out = settle(createBandGain(64), bands, 3);
    for (let i = 0; i < 16; i++) expect(shapeLevel(out[i], 1)).toBeGreaterThan(0.9);
    for (let i = 16; i < 64; i++) expect(shapeLevel(out[i], 1)).toBeLessThan(0.1);
  });

  it("normalises a quiet mix to the same profile, but keeps silence and hiss out", () => {
    const loud = new Float32Array(64).map((_, i) => 0.9 * Math.exp(-i / 20));
    const quiet = loud.map((v) => v * 0.25);
    const a = settle(createBandGain(64), loud, 3);
    const b = settle(createBandGain(64), quiet, 3);
    for (let i = 0; i < 40; i++) expect(b[i]).toBeCloseTo(a[i], 4); // above the floor
    const hiss = settle(createBandGain(64), new Float32Array(64).fill(0.004), 3);
    for (let i = 0; i < 64; i++) expect(shapeLevel(hiss[i], 1)).toBe(0);
  });
});

describe("createAttacks", () => {
  it("fires a jet on a rising step, only in that band, and never on a steady tone", () => {
    const a = createAttacks(64);
    const lv = new Float32Array(64).fill(0.5);
    const jets = new Float32Array(64);
    let steady = 0;
    for (let i = 0; i < 180; i++) {
      a.step(lv, DT, 1, false, jets);
      if (i >= 60) for (const j of jets) steady = Math.max(steady, j);
    }
    expect(steady).toBeLessThan(0.01);
    lv[3] = 1;
    let peak = 0;
    let others = 0;
    for (let i = 0; i < 3; i++) {
      a.step(lv, DT, 1, false, jets);
      peak = Math.max(peak, jets[3]);
      for (let b = 0; b < 64; b++) if (b !== 3) others = Math.max(others, jets[b]);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(others).toBeLessThan(0.01);
  });

  it("decays over ~150–300 ms, is bounded, and scales with reactivity", () => {
    /** @param {number} r */
    const trace = (r) => {
      const a = createAttacks(1);
      const lv = new Float32Array([0.2]);
      const jets = new Float32Array(1);
      for (let i = 0; i < 60; i++) a.step(lv, DT, r, false, jets);
      lv[0] = 1; // a big hit, then held
      const out = [];
      for (let i = 0; i < 40; i++) {
        a.step(lv, DT, r, false, jets);
        out.push(jets[0]);
      }
      return out;
    };
    const one = trace(1);
    const peak = Math.max(...one);
    const at = one.indexOf(peak);
    expect(peak).toBeLessThanOrEqual(1);
    expect(one[at + 9]).toBeGreaterThan(0.15 * peak); // 150 ms on
    expect(one[at + 24]).toBeLessThan(0.05 * peak); // 400 ms on
    const two = trace(2);
    expect(Math.max(...two)).toBeCloseTo(2 * peak, 5);
    expect(Math.max(...trace(0))).toBe(0);
  });

  it("with reduceFlashing, a 10 Hz train of hits starts at most 3 jets a second per band", () => {
    for (const reduce of [false, true]) {
      const a = createAttacks(1);
      const lv = new Float32Array(1);
      const jets = new Float32Array(1);
      let starts = 0;
      let prev = 0;
      for (let i = 0; i < 120; i++) {
        lv[0] = i % 6 < 2 ? 1 : 0.1; // 10 Hz at 60 fps
        a.step(lv, DT, 1, reduce, jets);
        if (jets[0] > prev * 1.5 + 0.05) starts++;
        prev = jets[0];
      }
      if (reduce) expect(starts).toBeLessThanOrEqual(6 + 1); // 2 s
      else expect(starts).toBeGreaterThan(15);
    }
  });

  it("behaves the same at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const sample = (hz) => {
      const a = createAttacks(1);
      const lv = new Float32Array(1);
      const jets = new Float32Array(1);
      const out = [];
      for (let i = 0; i < hz * 2; i++) {
        const t = i / hz;
        lv[0] = 0.15 + 0.8 * Math.exp(-((t * 2) % 1) * 7); // 120 BPM kick envelope
        a.step(lv, 1 / hz, 1, false, jets);
        if (i % (hz / 20) === 0) out.push(jets[0]);
      }
      return out;
    };
    const a = sample(60);
    const b = sample(120);
    expect(Math.max(...a)).toBeGreaterThan(0.5);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.15);
  });
});
