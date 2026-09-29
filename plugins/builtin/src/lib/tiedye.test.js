// @ts-check
import { describe, expect, it } from "vitest";
import { createBandWidths } from "./tiedye.js";

describe("createBandWidths", () => {
  it("gives even bands for a silent track", () => {
    const bw = createBandWidths();
    const w = bw.step(new Float32Array(64), 6, 1 / 60, 1);
    expect(w.length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < 6; i++) expect(w[i]).toBeCloseTo(1 / 6, 6);
  });

  /** 64 bands with `level` in region `k` of `n` (contiguous groups), else `rest`. */
  const regionBands = (/** @type {number} */ n, /** @type {number} */ k, level = 0.8, rest = 0.1) => {
    const b = new Float32Array(64);
    for (let i = 0; i < 64; i++) b[i] = Math.floor((i * n) / 64) === k ? level : rest;
    return b;
  };
  /** Settle for `s` seconds at 60 Hz. */
  const settle = (/** @type {ReturnType<typeof createBandWidths>} */ bw, /** @type {Float32Array} */ b, n = 6, s = 3, r = 1) => {
    let w = bw.step(b, n, 1 / 60, r);
    for (let f = 1; f < s * 60; f++) w = bw.step(b, n, 1 / 60, r);
    return w;
  };
  const sum = (/** @type {Float32Array} */ w, /** @type {number} */ n) => w.slice(0, n).reduce((a, x) => a + x, 0);

  it("widens the band whose spectrum region is loud, still summing to one full turn", () => {
    for (const n of [5, 6]) {
      const w = settle(createBandWidths(), regionBands(n, 2), n);
      expect(sum(w, n)).toBeCloseTo(1, 6);
      for (let i = 0; i < n; i++) if (i !== 2) expect(w[2]).toBeGreaterThan(w[i] * 1.3);
    }
  });

  it("follows a change in the mix smoothly, the same at 60 and 120 Hz", () => {
    /** @type {number[]} */
    const at = [];
    for (const hz of [60, 120]) {
      const bw = createBandWidths();
      const quiet = new Float32Array(64);
      for (let f = 0; f < hz; f++) bw.step(quiet, 6, 1 / hz, 1);
      const loud = regionBands(6, 0, 1, 0);
      const first = bw.step(loud, 6, 1 / hz, 1)[0];
      expect(first, `${hz} Hz first frame`).toBeLessThan(1 / 6 + 0.05);
      for (let f = 1; f < hz; f++) bw.step(loud, 6, 1 / hz, 1);
      at.push(bw.step(loud, 6, 0, 1)[0]);
    }
    expect(at[0]).toBeGreaterThan(1 / 6 + 0.15); // most of the way after 1 s
    expect(at[0]).toBeCloseTo(at[1], 2);
  });

  it("is monotonic in each region's energy", () => {
    for (let k = 0; k < 6; k++) {
      let prev = 0;
      for (const level of [0, 0.1, 0.3, 0.6, 1]) {
        const w = settle(createBandWidths(), regionBands(6, k, level, 0.2));
        expect(w[k], `region ${k} at ${level}`).toBeGreaterThanOrEqual(prev);
        prev = w[k];
      }
    }
  });
});
