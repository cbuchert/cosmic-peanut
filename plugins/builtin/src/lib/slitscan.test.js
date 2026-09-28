// @ts-check
import { describe, expect, it } from "vitest";
import {
  bandFeatures,
  createRowBuilder,
  findTrigger,
  GAIN_FLOOR,
  resampleRow,
  STREAK_DECAY,
} from "./slitscan.js";

describe("resampleRow", () => {
  it("linearly interpolates every output texel from the span, first and last samples exact", () => {
    const wave = new Float32Array(2048);
    for (let i = 0; i < wave.length; i++) wave[i] = Math.sin(i * 0.37) * 0.8 + (i % 7) * 0.01;
    const out = new Float32Array(256);
    resampleRow(wave, 100, 1000, out);
    for (let i = 0; i < out.length; i++) {
      const x = 100 + (i * 999) / 255;
      const i0 = Math.floor(x);
      const f = x - i0;
      const want = wave[i0] + (wave[Math.min(i0 + 1, 1099)] - wave[i0]) * f;
      expect(out[i], `texel ${i}`).toBeCloseTo(want, 5);
    }
    expect(out[0]).toBe(wave[100]);
    expect(out[255]).toBe(wave[1099]);
  });
});

describe("findTrigger", () => {
  it("finds the first rising zero crossing within the search range, so a steady tone lines up row to row", () => {
    const wave = new Float32Array(2048);
    for (const phase of [0.3, 1.7, 4]) {
      for (let i = 0; i < wave.length; i++) wave[i] = Math.sin((i + phase * 20) * ((2 * Math.PI) / 120));
      const t = findTrigger(wave, 1024);
      expect(wave[t - 1]).toBeLessThanOrEqual(0);
      expect(wave[t]).toBeGreaterThan(0);
      expect(t).toBeLessThan(121); // the first one, within a period
    }
  });

  it("returns 0 when there is no crossing in range (silence, DC)", () => {
    expect(findTrigger(new Float32Array(2048), 1024)).toBe(0);
    expect(findTrigger(new Float32Array(2048).fill(0.5), 1024)).toBe(0);
  });
});

describe("bandFeatures", () => {
  const bands = new Float32Array(64);
  const f = { hue: -1, energy: -1 };

  it("hue is the bands' centroid: bass-heavy low, treble-heavy high, 0-1", () => {
    bands.fill(0);
    bands[2] = 1;
    bandFeatures(bands, f);
    expect(f.hue).toBeCloseTo(2 / 63, 6);
    bands.fill(0);
    bands[60] = 0.5;
    bands[62] = 0.5;
    bandFeatures(bands, f);
    expect(f.hue).toBeCloseTo(61 / 63, 6);
  });

  it("energy is the mean band level; silence gives energy 0 and a neutral hue", () => {
    bands.fill(0.25);
    bandFeatures(bands, f);
    expect(f.energy).toBeCloseTo(0.25, 6);
    expect(f.hue).toBeCloseTo(0.5, 6);
    bands.fill(0);
    bandFeatures(bands, f);
    expect(f.energy).toBe(0);
    expect(f.hue).toBe(0.5);
  });
});

describe("createRowBuilder", () => {
  const W = 256;
  /** @param {number} n @param {number} amp @param {number} phase */
  const tone = (n, amp, phase = 0) => {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = amp * Math.sin((i + phase) * ((2 * Math.PI) / 97));
    return w;
  };
  const bands = new Float32Array(64).fill(0.2);

  it("fills W RGBA texels from the trigger-aligned first half of any waveform length", () => {
    for (const n of [1024, 2048, 4096, 301]) {
      const b = createRowBuilder(W);
      const row = new Float32Array(W * 4);
      const wave = tone(n, 1, 13);
      b.build(wave, bands, row);
      const t = findTrigger(wave, n - (n >> 1));
      const want = resampleRow(wave, t, n >> 1, new Float32Array(W));
      const g = row[4] / want[1]; // gain is one scalar per row
      for (let i = 0; i < W; i++) expect(row[i * 4], `${n}: texel ${i}`).toBeCloseTo(want[i] * g, 4);
      expect(g).toBeGreaterThan(0.5);
    }
  });

  /** @param {Float32Array} row @param {number} ch */
  const maxAbs = (row, ch) => {
    let m = 0;
    for (let i = ch; i < row.length; i += 4) m = Math.max(m, Math.abs(row[i]));
    return m;
  };

  it("auto-gains quiet music to fill -1..1 but leaves hiss dark", () => {
    const row = new Float32Array(W * 4);
    const quiet = createRowBuilder(W);
    quiet.build(tone(2048, 0.2), bands, row);
    expect(maxAbs(row, 0)).toBeGreaterThan(0.95);
    expect(maxAbs(row, 0)).toBeLessThanOrEqual(1.0001);
    const hiss = createRowBuilder(W);
    hiss.build(tone(2048, 0.01), bands, row);
    expect(maxAbs(row, 0)).toBeLessThanOrEqual(0.01 / GAIN_FLOOR + 1e-6);
  });

  it("after a loud passage, the gain recovers slowly (no pumping on a single quiet row)", () => {
    const row = new Float32Array(W * 4);
    const b = createRowBuilder(W);
    b.build(tone(2048, 1), bands, row);
    b.build(tone(2048, 0.25), bands, row);
    expect(maxAbs(row, 0)).toBeLessThan(0.3);
    for (let k = 0; k < 1000; k++) b.build(tone(2048, 0.25), bands, row);
    expect(maxAbs(row, 0)).toBeGreaterThan(0.95);
  });

  it("the streak channel holds each lane's peak and decays it row by row", () => {
    const row = new Float32Array(W * 4);
    const b = createRowBuilder(W);
    b.build(tone(2048, 1), bands, row);
    const i = 4 * 20;
    const first = row[i + 1];
    expect(first).toBeCloseTo(Math.abs(row[i]), 6);
    const silence = new Float32Array(2048);
    for (let k = 1; k <= 5; k++) {
      b.build(silence, bands, row);
      expect(row[i + 1]).toBeCloseTo(first * STREAK_DECAY ** k, 5);
    }
  });

  it("carries the bands' hue and energy in B and A of every texel", () => {
    const row = new Float32Array(W * 4);
    const bb = new Float32Array(64);
    bb[10] = 0.6;
    createRowBuilder(W).build(tone(2048, 1), bb, row);
    for (let i = 0; i < W; i++) {
      expect(row[i * 4 + 2]).toBeCloseTo(10 / 63, 6);
      expect(row[i * 4 + 3]).toBeCloseTo(0.6 / 64, 6);
    }
  });
});
