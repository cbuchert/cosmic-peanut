// @ts-check
import { describe, expect, it } from "vitest";
import { createSweep, DEFAULT_SPEED, REDUCED_SPEED } from "./radar.js";

/** @param {Partial<import('./radar.js').SweepInput>} o */
const input = (o = {}) => ({ sync: "off", speed: 0.3, bpm: 0, beatPhase: 0, reduceMotion: false, ...o });

describe("createSweep", () => {
  it("free-runs at `speed` rotations per second at any frame rate", () => {
    for (const hz of [60, 120]) {
      const s = createSweep();
      for (let f = 0; f < hz * 4; f++) s.step(1 / hz, input({ speed: 0.5 }));
      expect(s.turns, `${hz} Hz`).toBeCloseTo(2, 6);
    }
  });

  /** Run `seconds` at `hz` with a steady tempo; return the mean rate (turns/s) over the last 2 s. */
  function lockedRate(/** @type {string} */ sync, /** @type {number} */ bpm, hz = 60, seconds = 12) {
    const s = createSweep();
    const n = Math.round(seconds * hz);
    let mark = 0;
    for (let f = 0; f < n; f++) {
      const t = (f + 1) / hz;
      s.step(1 / hz, input({ sync, bpm, beatPhase: ((t * bpm) / 60) % 1 }));
      if (f === n - 2 * hz - 1) mark = s.turns;
    }
    return (s.turns - mark) / 2;
  }

  it("locks one rotation per bar (4 beats) or per beat to the tempo", () => {
    for (const hz of [60, 120]) {
      expect(lockedRate("bar", 120, hz), `bar ${hz}`).toBeCloseTo(0.5, 2);
      expect(lockedRate("beat", 120, hz), `beat ${hz}`).toBeCloseTo(2, 2);
      expect(lockedRate("bar", 90, hz), `bar 90 ${hz}`).toBeCloseTo(90 / 60 / 4, 2);
    }
  });

  it("uses `speed` when sync is off or the tempo is unknown", () => {
    expect(lockedRate("off", 120)).toBeCloseTo(0.3, 6);
    const s = createSweep();
    for (let f = 0; f < 120; f++) s.step(1 / 60, input({ sync: "bar", bpm: 0, speed: 0.25 }));
    expect(s.turns).toBeCloseTo(0.5, 6);
  });

  it("phase-aligns smoothly: beats land on the quarter bearings (bar) without jumps or reversals", () => {
    for (const sync of ["bar", "beat"]) {
      const bpt = sync === "bar" ? 4 : 1;
      const s = createSweep();
      const dt = 1 / 120;
      for (let f = 0; f < 45; f++) s.step(dt, input({ speed: 0.3 })); // free-running, arbitrary phase
      let prevRate = s.rate;
      for (let f = 0; f < 120 * 10; f++) {
        const t = f * dt + 0.123;
        const before = s.turns;
        s.step(dt, input({ sync, bpm: 128, beatPhase: ((t * 128) / 60) % 1 }));
        const rate = (s.turns - before) / dt;
        expect(rate, sync).toBeGreaterThan(0);
        expect(Math.abs(rate - prevRate), sync).toBeLessThan(0.05 / bpt + 0.02); // turns/s per frame
        prevRate = rate;
      }
      const t = 120 * 10 * dt + 0.123 - dt;
      const beats = s.turns * bpt;
      let err = ((t * 128) / 60) % 1 - (beats - Math.floor(beats));
      err -= Math.round(err);
      expect(Math.abs(err), sync).toBeLessThan(0.01);
    }
  });

  it("with Reduce motion, slows the sweep when speed/sync are at their defaults, respects user choices", () => {
    const run = (/** @type {Partial<import('./radar.js').SweepInput>} */ o) => {
      const s = createSweep();
      for (let f = 0; f < 600; f++) {
        const t = (f + 1) / 60;
        s.step(1 / 60, input({ ...o, beatPhase: o.bpm ? ((t * o.bpm) / 60) % 1 : 0 }));
      }
      return s.turns / 10;
    };
    expect(REDUCED_SPEED).toBeLessThan(DEFAULT_SPEED);
    expect(run({ speed: DEFAULT_SPEED, reduceMotion: true })).toBeCloseTo(REDUCED_SPEED, 6);
    expect(run({ speed: DEFAULT_SPEED, reduceMotion: false })).toBeCloseTo(DEFAULT_SPEED, 6);
    expect(run({ speed: 0.8, reduceMotion: true })).toBeCloseTo(0.8, 6);
    // Default sync (bar): one rotation per two bars instead of one.
    expect(run({ sync: "bar", bpm: 120, reduceMotion: true })).toBeCloseTo(0.25, 1);
    expect(run({ sync: "beat", bpm: 120, reduceMotion: true })).toBeCloseTo(2, 1);
  });
});
