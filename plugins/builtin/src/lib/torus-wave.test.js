// @ts-check
import { describe, expect, it } from "vitest";
import {
  ageOf, BASE_GAIN, BIRTH, COLS, createWaveHistory, dispAt, findTrigger, LAP_ROWS, liveDisp, maxDisp, resampleLoop,
  ROW_SLEW, ROWS, rowGain, smoothRing, STAMP, stepFactor, WAVE_CLAMP, waveAmp, windowLength,
} from "./torus-wave.js";
import { THICKNESS } from "./torus.js";

const LEN = 2048;
/** A waveform: a sine of `period` samples (plus a harmonic), starting at phase offset `off`. */
function tone(/** @type {number} */ period, off = 0, gain = 0.5, out = new Float32Array(LEN)) {
  for (let i = 0; i < LEN; i++) {
    const x = (2 * Math.PI * (i + off)) / period;
    out[i] = gain * (Math.sin(x) + 0.4 * Math.sin(2 * x + 0.7));
  }
  return out;
}
/** Deterministic noise. */
function noise(/** @type {number} */ seed, gain = 0.5, out = new Float32Array(LEN)) {
  let s = seed;
  for (let i = 0; i < LEN; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = gain * ((s / 4294967296) * 2 - 1);
  }
  return out;
}
/** One push per step at travel 2 (LAP_ROWS / 2 rows a second). */
const ONE = 2 / LAP_ROWS;
const opts = (over = {}) => ({ travel: 2, detail: 0.4, env: 0, bassAtt: 1, reactivity: 1, ...over });
const row = (/** @type {ReturnType<typeof createWaveHistory>} */ h, /** @type {number} */ r) => Array.from(h.data.subarray(r * h.cols, (r + 1) * h.cols));

describe("waveform → ring", () => {
  it("spans 1024 samples at Detail 0 down to 192 at Detail 1", () => {
    expect(windowLength(0)).toBe(1024);
    expect(windowLength(1)).toBe(192);
    expect(windowLength(0.5)).toBe(608);
  });

  it("triggers on the first rising zero crossing that leaves the span after it", () => {
    const w = tone(100, 30);
    const i = findTrigger(w, 600);
    expect(w[i - 1]).toBeLessThan(0);
    expect(w[i]).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(110);
    expect(findTrigger(new Float32Array(LEN), 600)).toBe(0); // silence: no crossing
  });

  it("closes the ring seamlessly round θ (no jump at the wrap, no zeroed taper)", () => {
    const out = new Float32Array(COLS);
    const w = tone(97.3); // a period that doesn't divide the window
    resampleLoop(w, 10, 600, out);
    let step = 0;
    for (let j = 1; j < COLS; j++) step = Math.max(step, Math.abs(out[j] - out[j - 1]));
    expect(Math.abs(out[0] - out[COLS - 1])).toBeLessThanOrEqual(1.05 * step);
    expect(Math.abs(out[0])).toBeGreaterThan(0.05); // not tapered to zero there
  });

  it("gives a steady tone a stable shape, whatever the phase it arrives at", () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 6; i++) h.step(tone(120, i * 37), 0.25, opts());
    const a = row(h, h.head);
    const b = row(h, (h.head + ROWS - 1) % ROWS);
    for (let j = 0; j < COLS; j++) expect(a[j]).toBeCloseTo(b[j], 2);
  });

  it("auto-gains: a quiet and a loud tone fill about the same height", () => {
    const peakOf = (/** @type {number} */ g) => {
      const h = createWaveHistory(COLS, ROWS, () => {});
      for (let i = 0; i < 400; i++) h.step(tone(120, i * 37, g), 1 / 60, opts());
      return Math.max(...row(h, h.head).map(Math.abs));
    };
    expect(peakOf(0.05) / peakOf(0.8)).toBeGreaterThan(0.8);
    expect(peakOf(0.8)).toBeGreaterThan(0.8);
  });
});

describe("ring rounding", () => {
  it("keeps the shape of a slow wave and rounds off sample-to-sample spikes, seamlessly round θ", () => {
    const tmp = new Float32Array(COLS);
    const slow = new Float32Array(COLS);
    const jag = new Float32Array(COLS);
    for (let j = 0; j < COLS; j++) {
      slow[j] = Math.sin((2 * Math.PI * 3 * j) / COLS);
      jag[j] = j % 2 ? 1 : -1;
    }
    const before = slow.slice();
    smoothRing(slow, tmp);
    smoothRing(jag, tmp);
    for (let j = 0; j < COLS; j++) expect(Math.abs(slow[j] - before[j])).toBeLessThan(0.05);
    expect(Math.max(...jag.map(Math.abs))).toBeLessThan(0.05);
    // round the wrap too: a spike at column 0 spreads to the last column
    const spike = new Float32Array(COLS);
    spike[0] = 1;
    smoothRing(spike, tmp);
    expect(spike[COLS - 1]).toBeCloseTo(spike[1], 12);
    expect(spike[COLS - 1]).toBeGreaterThan(0);
  });
});

describe("wave history", () => {
  it("pushes LAP_ROWS rows per travel time (one lap round the tube), one row upload each, head wrapping", () => {
    expect(ROWS).toBeGreaterThanOrEqual(Math.ceil(LAP_ROWS * (1 + BIRTH)) + 2); // history outlives a lap
    /** @type {number[]} */ const rows = [];
    const h = createWaveHistory(COLS, ROWS, (r) => rows.push(r));
    let n = 0;
    for (let i = 0; i < LAP_ROWS; i++) n += h.step(tone(120), 1 / LAP_ROWS, opts({ travel: 2 })); // 1 s, exact steps
    expect(n).toBe(LAP_ROWS / 2);
    expect(rows.length).toBe(n);
    expect(rows[0]).toBe(1);
    expect(rows[rows.length - 1]).toBe(h.head);
    expect(h.frac).toBeGreaterThanOrEqual(0);
    expect(h.frac).toBeLessThan(1);
    for (let i = 0; i < 2 * LAP_ROWS; i++) h.step(tone(120), 1 / LAP_ROWS, opts({ travel: 2 }));
    expect(h.head).toBe(((3 * LAP_ROWS) / 2) % ROWS);
  });

  it("uploads the row it just wrote", () => {
    let got = new Float32Array(0);
    const h = createWaveHistory(COLS, ROWS, (r, d) => (got = d.slice()));
    h.step(tone(120), 0.1, opts());
    expect(Array.from(got)).toEqual(Array.from(h.data.subarray(h.head * COLS, (h.head + 1) * COLS)));
  });

  it("stamps the rows laid down on a beat larger, and leaves the rows already there alone", () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 40; i++) h.step(tone(120), ONE, opts());
    const quiet = Math.max(...row(h, h.head).map(Math.abs));
    const before = h.data.slice();
    const stamped = [];
    for (let i = 0; i < 4; i++) {
      h.step(tone(120), ONE, opts({ env: 1 }));
      stamped.push(h.head);
    }
    const loud = Math.max(...row(h, h.head).map(Math.abs));
    expect(loud / quiet).toBeCloseTo(Math.min(1 + STAMP, WAVE_CLAMP / quiet), 1);
    for (let r = 0; r < ROWS; r++) {
      if (stamped.includes(r)) continue;
      for (let j = 0; j < COLS; j++) expect(h.data[r * COLS + j]).toBe(before[r * COLS + j]);
    }
  });

  it("limits the change from one row to the next (a stamp builds over a few rows), so the march's steps stay long", () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 300; i++) h.step(i % 2 ? noise(i, 0.9) : tone(60 + i, 0, 0.9), ONE, opts({ env: i % 8 < 2 ? 1 : 0, reactivity: 2 }));
    expect(Math.max(...h.slopeRow)).toBeLessThanOrEqual(ROW_SLEW + 1e-6);
    for (let r = 1; r < 20; r++) {
      const a = row(h, (h.head - r + ROWS) % ROWS);
      const b = row(h, (h.head - r + 1 + ROWS) % ROWS);
      for (let j = 0; j < COLS; j++) expect(Math.abs(a[j] - b[j])).toBeLessThanOrEqual(ROW_SLEW + 1e-6);
    }
  });

  it("bakes the bass into each row's height as it is laid down (more bass, bigger)", () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 30; i++) h.step(tone(120), ONE, opts());
    h.step(tone(120), ONE, opts({ bassAtt: 0.3 }));
    const lo = Math.max(...row(h, h.head).map(Math.abs));
    h.step(tone(120), ONE, opts({ bassAtt: 1.8 }));
    const hi = Math.max(...row(h, h.head).map(Math.abs));
    expect(hi).toBeGreaterThan(1.2 * lo);
    expect(Math.max(...row(h, (h.head + ROWS - 1) % ROWS).map(Math.abs))).toBe(lo); // the earlier row keeps its size
    expect(rowGain(0, 1, 1)).toBe(BASE_GAIN);
  });

  it("scales with Reactivity (0 lays down a flat surface) and clamps", () => {
    expect(rowGain(0, 0, 1)).toBe(0);
    expect(rowGain(0, 1, 1)).toBe(BASE_GAIN);
    expect(BASE_GAIN).toBeGreaterThan(1); // ordinary music makes clearly visible waves
    expect(rowGain(1, 1, 1)).toBeCloseTo(BASE_GAIN * (1 + STAMP), 12);
    expect(rowGain(1, 2, 1)).toBeCloseTo(2 * BASE_GAIN * (1 + STAMP), 12);
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 20; i++) h.step(noise(i, 0.9), ONE, opts({ env: 1, reactivity: 2 }));
    expect(Math.max(...h.data.map(Math.abs))).toBeLessThanOrEqual(WAVE_CLAMP);
    const f = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 20; i++) f.step(noise(i, 0.9), ONE, opts({ reactivity: 0 }));
    expect(Math.max(...f.data.map(Math.abs))).toBe(0);
  });
});

describe("displacement on the torus", () => {
  const filled = () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    for (let i = 0; i < 300; i++) h.step(i % 2 ? noise(i, 0.6) : tone(90 + i, 0, 0.6), 1 / 60, opts({ env: i % 30 < 3 ? 1 : 0, bassAtt: 1.5 }));
    return h;
  };

  it("ages one full lap round the tube: hole 0, top ¼, outer equator ½, bottom ¾, back to the hole", () => {
    expect(ageOf(Math.PI)).toBeCloseTo(0, 12);
    expect(ageOf(Math.PI / 2)).toBeCloseTo(0.25, 12);
    expect(ageOf(0)).toBeCloseTo(0.5, 12);
    expect(ageOf(-Math.PI / 2)).toBeCloseTo(0.75, 12);
    expect(ageOf(-Math.PI + 1e-9)).toBeCloseTo(1, 6);
    let last = -1;
    for (let i = 0; i < 100; i++) {
      const a = ageOf(Math.PI - (i / 100) * 2 * Math.PI);
      expect(a).toBeGreaterThan(last);
      last = a;
    }
  });

  it("keeps waves full height all the way round: the row at each age is shown unfaded", () => {
    const h = filled();
    const amp = waveAmp(0.7, 0.36);
    const x = 17; // a column
    const theta = (2 * Math.PI * x) / COLS;
    for (const age of [BIRTH + 0.02, 0.25, 0.5, 0.75, 0.97]) {
      const r = age * LAP_ROWS - h.frac;
      const r0 = Math.floor(r);
      const at = (/** @type {number} */ k) => h.data[(((h.head - k) % ROWS) + ROWS) % ROWS * COLS + x];
      const want = amp * (at(r0) * (1 - (r - r0)) + at(r0 + 1) * (r - r0));
      expect(dispAt(h, theta, Math.PI - age * 2 * Math.PI, amp)).toBeCloseTo(want, 9);
    }
  });

  it("is seamless across θ = ±π, the outer equator, and the hole where the lap closes", () => {
    const h = filled();
    const amp = waveAmp(0.7, 0.36);
    for (const phi of [-2.5, -1, 0.4, 2, 3]) {
      expect(dispAt(h, Math.PI - 1e-7, phi, amp)).toBeCloseTo(dispAt(h, -Math.PI + 1e-7, phi, amp), 5);
    }
    for (const th of [-3, -1, 0.5, 2.2]) {
      // the hole: newborn waves cross-fade with the ones finishing their lap, no step, no dip
      expect(dispAt(h, th, Math.PI - 1e-7, amp)).toBeCloseTo(dispAt(h, th, -Math.PI + 1e-7, amp), 5);
      expect(dispAt(h, th, 1e-7, amp)).toBeCloseTo(dispAt(h, th, -1e-7, amp), 5);
    }
    // no dip at the hole: the waves there are as big as anywhere
    let hole = 0;
    let top = 0;
    for (let i = 0; i < COLS; i++) {
      const th = -Math.PI + (i / COLS) * 2 * Math.PI;
      hole = Math.max(hole, Math.abs(dispAt(h, th, Math.PI, amp)));
      top = Math.max(top, Math.abs(dispAt(h, th, Math.PI / 2, amp)));
    }
    expect(hole).toBeGreaterThan(0.3 * top);
  });

  it("stays inside ±maxDisp, which leaves the inside camera clear of the walls", () => {
    for (const k of [THICKNESS.min, 0.36, THICKNESS.max]) {
      expect(maxDisp(1, k)).toBeLessThanOrEqual(0.45 * k);
      expect(maxDisp(1, k)).toBeGreaterThan(0.3 * k);
      // Inside, the camera rides the centre circle: the nearest wall is k − maxDisp away.
      expect(k - maxDisp(1, k)).toBeGreaterThanOrEqual(0.55 * k);
      expect(maxDisp(1, k)).toBeCloseTo(waveAmp(1, k) * WAVE_CLAMP, 12);
    }
    const h = filled();
    const amp = waveAmp(1, 0.36);
    for (let i = 0; i < 2000; i++) {
      const d = dispAt(h, ((i * 0.7311) % 6.28) - 3.14, ((i * 0.3779) % 6.28) - 3.14, amp);
      expect(Math.abs(d)).toBeLessThanOrEqual(maxDisp(1, 0.36) + 1e-9);
    }
  });

  it("knows the largest displacement on the surface now (the march's shell), within maxDisp", () => {
    const h = filled();
    const amp = waveAmp(0.7, 0.36);
    const live = liveDisp(h, amp);
    expect(live).toBeLessThanOrEqual(maxDisp(0.7, 0.36));
    expect(live).toBeGreaterThan(0);
    for (let i = 0; i < 4000; i++) {
      const d = dispAt(h, ((i * 0.61803) % 1) * 2 * Math.PI - Math.PI, ((i * 0.41421) % 1) * 2 * Math.PI - Math.PI, amp);
      expect(Math.abs(d)).toBeLessThanOrEqual(live + 1e-12);
    }
    expect(liveDisp(createWaveHistory(COLS, ROWS, () => {}), amp)).toBe(0);
  });

  it("bounds the step: the march's factor covers the real gradient (no overstepping)", () => {
    const k = 0.36;
    const h = filled();
    for (const height of [0.3, 0.7, 1]) {
      const amp = waveAmp(height, k);
      const f = stepFactor(h, amp, k);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
      // Gradient of disp in world units, on the displaced shell (nearest the tube's centre and axis).
      const D = maxDisp(height, k);
      const q = k - D;
      let g = 0;
      const e = 1e-5;
      for (let i = 0; i < 4000; i++) {
        const th = ((i * 0.61803) % 1) * 2 * Math.PI - Math.PI;
        const ph = ((i * 0.41421) % 1) * 2 * Math.PI - Math.PI;
        const rho = 1 + q * Math.cos(ph);
        const dth = (dispAt(h, th + e, ph, amp) - dispAt(h, th - e, ph, amp)) / (2 * e) / rho;
        const dph = (dispAt(h, th, ph + e, amp) - dispAt(h, th, ph - e, amp)) / (2 * e) / q;
        g = Math.max(g, Math.hypot(dth, dph));
      }
      expect(1 / Math.sqrt(1 + g * g)).toBeGreaterThanOrEqual(f);
    }
    const flat = createWaveHistory(COLS, ROWS, () => {});
    expect(stepFactor(flat, waveAmp(1, k), k)).toBe(1);
  });
});
