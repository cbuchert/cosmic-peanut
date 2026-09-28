// @ts-check
import { describe, expect, it } from "vitest";
import {
  bandProfile,
  createSweep,
  DEFAULT_SPEED,
  GATE,
  inWedge,
  R_INNER,
  R_OUTER,
  radiusOfBand,
  REDUCED_SPEED,
  sweptWedge,
} from "./radar.js";

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

describe("sweptWedge", () => {
  it("paints every bearing once per rotation, no gaps or repeats, at 60/120 Hz and high speeds", () => {
    const COLS = 2048; // phosphor texels around the scope
    const w = new Float32Array(2);
    for (const hz of [60, 120]) {
      for (const speed of [0.05, 0.25, 2, 13]) {
        const s = createSweep();
        const hits = new Uint16Array(COLS);
        let prev = s.turns;
        for (let f = 0; f < hz * 3; f++) {
          const now = s.step(1 / hz, input({ speed }));
          sweptWedge(prev, now, w);
          for (let c = 0; c < COLS; c++) if (inWedge((c + 0.5) / COLS, w[0], w[1])) hits[c]++;
          prev = now;
        }
        const total = s.turns;
        for (let c = 0; c < COLS; c++) {
          const expected = Math.floor(total - (c + 0.5) / COLS) + 1; // crossings of this bearing
          expect(hits[c], `${hz} Hz speed ${speed} col ${c}`).toBe(Math.max(0, expected));
        }
      }
    }
  });

  it("caps the span at one full turn and wraps the start into 0–1", () => {
    const w = new Float32Array(2);
    sweptWedge(0.9, 3.4, w);
    expect(w[1]).toBe(1);
    sweptWedge(2.75, 3.05, w);
    expect(w[0]).toBeCloseTo(0.75, 6);
    expect(w[1]).toBeCloseTo(0.3, 6);
    expect(inWedge(0.02, w[0], w[1])).toBe(true);
    expect(inWedge(0.06, w[0], w[1])).toBe(false);
  });
});

describe("bandProfile", () => {
  const N = 256;
  const at = (/** @type {Float32Array} */ p, /** @type {number} */ r) => p[Math.min(N - 1, Math.floor(r * N))];
  // Outer edge of the brightest run (band 0 fills the center as a plateau out to R_INNER).
  const peakRadius = (/** @type {Float32Array} */ p) => (p.lastIndexOf(Math.max(...p)) + 0.5) / N;

  it("puts bass near the center and highs toward the rim", () => {
    expect(radiusOfBand(0)).toBeCloseTo(R_INNER, 6);
    expect(radiusOfBand(63)).toBeCloseTo(R_OUTER, 6);
    const bands = new Float32Array(64);
    const out = new Float32Array(N);
    for (const i of [0, 10, 40, 63]) {
      bands.fill(0);
      bands[i] = 0.9;
      bandProfile(bands, 1, out);
      expect(Math.abs(peakRadius(out) - radiusOfBand(i)), `band ${i}`).toBeLessThan(1.5 / N);
    }
  });

  it("interpolates between neighbouring bands", () => {
    const bands = new Float32Array(64);
    bands[20] = 0.5;
    bands[21] = 0.9;
    const out = bandProfile(bands, 1, new Float32Array(4096));
    const mid = (radiusOfBand(20) + radiusOfBand(21)) / 2;
    const v = out[Math.floor(mid * 4096)];
    const lo = (0.5 - GATE) / (1 - GATE);
    const hi = (0.9 - GATE) / (1 - GATE);
    expect(v).toBeCloseTo((lo + hi) / 2, 2);
  });

  it("gates the noise floor to black and scales by gain", () => {
    const out = new Float32Array(N);
    bandProfile(new Float32Array(64).fill(GATE * 0.9), 2, out);
    expect(Math.max(...out)).toBe(0);
    const bands = new Float32Array(64).fill(0.5);
    const a = at(bandProfile(bands, 1, new Float32Array(N)), 0.5);
    const b = at(bandProfile(bands, 2, new Float32Array(N)), 0.5);
    expect(a).toBeGreaterThan(0.3);
    expect(b).toBeCloseTo(2 * a, 5);
    expect(at(out.fill(9) && bandProfile(bands, 1, out), 0.995)).toBe(0); // nothing past the outermost band
  });
});
