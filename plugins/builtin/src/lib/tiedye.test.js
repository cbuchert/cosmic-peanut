// @ts-check
import { describe, expect, it } from "vitest";
import { createBandWidths, createSpin, DEFAULT_SPEED, TWIST_DEPTH } from "./tiedye.js";

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

/** @param {Partial<import('./tiedye.js').SpinInput>} o */
const spinIn = (o = {}) => ({ twist: 1.5, speed: DEFAULT_SPEED, bassAtt: 1, reactivity: 1, reduceMotion: false, ...o });

describe("createSpin", () => {
  it("at average bass settles on the Twist param and rotates at a steady rate at 60 and 120 Hz", () => {
    /** @type {number[]} */
    const turns = [];
    for (const hz of [60, 120]) {
      const s = createSpin();
      for (let f = 0; f < hz * 5; f++) s.step(1 / hz, spinIn());
      expect(s.twist).toBeCloseTo(1.5, 3);
      const t0 = s.turns;
      for (let f = 0; f < hz * 2; f++) s.step(1 / hz, spinIn());
      turns.push(s.turns - t0);
    }
    expect(turns[0]).toBeGreaterThan(0.01);
    expect(turns[0]).toBeCloseTo(turns[1], 5);
  });

  it("tightens with heavy bass and loosens with light bass, bounded however loud", () => {
    const at = (/** @type {number} */ bassAtt) => {
      const s = createSpin();
      for (let f = 0; f < 600; f++) s.step(1 / 60, spinIn({ bassAtt, reactivity: 2 }));
      return s.twist;
    };
    expect(at(1.6)).toBeGreaterThan(1.5 * 1.1);
    expect(at(0.3)).toBeLessThan(1.5 * 0.9);
    expect(at(50)).toBeLessThanOrEqual(1.5 * (1 + TWIST_DEPTH) + 1e-6);
    expect(at(0)).toBeGreaterThanOrEqual(1.5 * (1 - TWIST_DEPTH) - 1e-6);
  });

  it("never jerks: a bass slam moves twist and rotation rate a little per frame", () => {
    const s = createSpin();
    for (let f = 0; f < 120; f++) s.step(1 / 60, spinIn({ bassAtt: 0 }));
    let tw = s.twist;
    let tu = s.turns;
    let rate = 0;
    for (let f = 0; f < 120; f++) {
      s.step(1 / 60, spinIn({ bassAtt: f % 2 ? 0 : 2, reactivity: 2 }));
      const r = (s.turns - tu) * 60;
      if (f > 0) expect(Math.abs(r - rate)).toBeLessThan(0.005);
      expect(Math.abs(s.twist - tw)).toBeLessThan(0.02);
      rate = r;
      tw = s.twist;
      tu = s.turns;
    }
  });

  it("with Reduce motion at default Speed rotates slower and changes twist more gently", () => {
    const run = (/** @type {boolean} */ reduceMotion, speed = DEFAULT_SPEED) => {
      const s = createSpin();
      for (let f = 0; f < 60; f++) s.step(1 / 60, spinIn({ reduceMotion, speed, bassAtt: 1 }));
      const t0 = s.turns;
      for (let f = 0; f < 60; f++) s.step(1 / 60, spinIn({ reduceMotion, speed, bassAtt: 2 }));
      return { turns: s.turns - t0, twist: s.twist - 1.5 };
    };
    const normal = run(false);
    const reduced = run(true);
    expect(reduced.turns).toBeLessThan(normal.turns * 0.6);
    expect(reduced.twist).toBeLessThan(normal.twist * 0.6);
    // A Speed the user picked is respected.
    expect(run(true, 1.7).turns).toBeCloseTo(run(false, 1.7).turns, 6);
  });
});
