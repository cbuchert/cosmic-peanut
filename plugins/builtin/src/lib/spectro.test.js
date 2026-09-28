// @ts-check
import { describe, expect, it } from "vitest";
import { logColumns, resampleSpectrum } from "./spectro.js";

const F_MIN = 30;
const F_MAX = 16000;

describe("logColumns", () => {
  it("linear: low → high left → right on a log axis, contiguous, spanning fMin–fMax", () => {
    const lo = new Float32Array(256);
    const hi = new Float32Array(256);
    logColumns("linear", F_MIN, F_MAX, lo, hi);
    expect(lo[0]).toBeCloseTo(F_MIN, 3);
    expect(hi[255]).toBeCloseTo(F_MAX, 0);
    for (let i = 0; i < 256; i++) {
      expect(hi[i]).toBeGreaterThan(lo[i]);
      if (i > 0) {
        expect(lo[i]).toBeCloseTo(hi[i - 1], 2); // contiguous
        expect(hi[i] / lo[i]).toBeCloseTo(hi[0] / lo[0], 4); // equal log widths
      }
    }
  });

  it("mirrored: lowest at the two centre columns, highest at both edges, symmetric and monotonic", () => {
    const lo = new Float32Array(256);
    const hi = new Float32Array(256);
    logColumns("mirrored", F_MIN, F_MAX, lo, hi);
    expect(lo[127]).toBeCloseTo(F_MIN, 3);
    expect(lo[128]).toBeCloseTo(F_MIN, 3);
    expect(hi[0]).toBeCloseTo(F_MAX, 0);
    expect(hi[255]).toBeCloseTo(F_MAX, 0);
    for (let i = 0; i < 128; i++) {
      expect(lo[i]).toBeCloseTo(lo[255 - i], 3);
      expect(hi[i]).toBeCloseTo(hi[255 - i], 3);
      if (i > 0) expect(lo[i]).toBeLessThan(lo[i - 1]); // falls toward the centre
    }
    // Each half is its own contiguous log axis.
    for (let i = 129; i < 256; i++) expect(lo[i]).toBeCloseTo(hi[i - 1], 2);
  });

  it("unknown layouts fall back to mirrored", () => {
    const a = [new Float32Array(64), new Float32Array(64)];
    const b = [new Float32Array(64), new Float32Array(64)];
    logColumns("mirrored", F_MIN, F_MAX, a[0], a[1]);
    logColumns("bogus", F_MIN, F_MAX, b[0], b[1]);
    expect(b[0]).toEqual(a[0]);
  });
});

/** Linear-layout column edges for tests. */
function cols(n = 256) {
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  logColumns("linear", F_MIN, F_MAX, lo, hi);
  return { lo, hi };
}

describe("resampleSpectrum", () => {
  for (const len of [1024, 512, 2048]) {
    it(`a single strong bin lands at full strength in the column covering its frequency (${len} bins)`, () => {
      const { lo, hi } = cols();
      const sr = 48000;
      const binHz = sr / 2 / len;
      const out = new Float32Array(256);
      for (const hz of [60, 440, 3000, 12000]) {
        const k = Math.round(hz / binHz);
        const spec = new Float32Array(len);
        spec[k] = 0.8;
        resampleSpectrum(spec, sr, lo, hi, out);
        const f = k * binHz;
        let col = 0;
        while (col < 255 && hi[col] <= f) col++;
        expect(out[col]).toBeCloseTo(0.8, 5);
        // Far away (≥ 2 octaves) stays empty.
        for (let i = 0; i < 256; i++) if (hi[i] < f / 4 || lo[i] > f * 4) expect(out[i]).toBe(0);
      }
    });
  }

  it("keeps a narrow partial where a column spans many bins (max, not mean)", () => {
    const { lo, hi } = cols(64); // wide columns: ~15 bins each up top
    const spec = new Float32Array(1024);
    spec[600] = 0.5;
    const out = new Float32Array(64);
    resampleSpectrum(spec, 48000, lo, hi, out);
    let best = 0;
    for (let i = 0; i < 64; i++) if (out[i] > best) best = out[i];
    expect(best).toBeCloseTo(0.5, 5);
  });

  it("interpolates between bins where columns are narrower than a bin (smooth bass, no gaps)", () => {
    const { lo, hi } = cols();
    const spec = new Float32Array(1024).fill(0);
    spec[2] = 1; // 46.9 Hz
    spec[3] = 0.5; // 70.3 Hz
    const out = new Float32Array(256);
    resampleSpectrum(spec, 48000, lo, hi, out);
    // Columns between the two bins take in-between values, falling from bin 2 toward bin 3.
    let seen = 0;
    for (let i = 0; i < 256; i++) {
      const c = Math.sqrt(lo[i] * hi[i]);
      if (c > 48 && c < 69 && hi[i] - lo[i] < 23) {
        expect(out[i]).toBeGreaterThan(0.5);
        expect(out[i]).toBeLessThan(1);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(2);
  });
});
