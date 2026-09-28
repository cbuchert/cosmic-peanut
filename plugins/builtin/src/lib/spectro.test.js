// @ts-check
import { describe, expect, it } from "vitest";
import { RISE_MAX, RISE_MIN, createSpectroGain, logColumns, resampleSpectrum, riseSpeed } from "./spectro.js";

const DT = 1 / 60;

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

/** Run a gain on fixed column magnitudes for `seconds`; returns its last output. */
function settleGain(/** @type {ReturnType<typeof createSpectroGain>} */ g, /** @type {Float32Array} */ mags, /** @type {number} */ seconds, dt = DT) {
  const out = new Float32Array(mags.length);
  for (let t = 0; t < seconds; t += dt) g.step(mags, dt, out);
  return out;
}

describe("createSpectroGain", () => {
  it("silence and hiss under the floor read 0", () => {
    const g = createSpectroGain(32);
    expect(Array.from(settleGain(g, new Float32Array(32), 2))).toEqual(new Array(32).fill(0));
    const hiss = settleGain(createSpectroGain(32), new Float32Array(32).fill(3e-4), 2); // ≈ −70 dB
    for (const v of hiss) expect(v).toBe(0);
  });

  it("is monotonic in magnitude; a tone 20 dB under the loudest reads clearly lower but not dead", () => {
    const mags = new Float32Array(32).map((_, i) => 1e-3 * 10 ** (i / 16)); // −60 … −21 dB
    const out = settleGain(createSpectroGain(32), mags, 3);
    for (let i = 1; i < 32; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    expect(out[31]).toBeCloseTo(1, 5);
    const two = new Float32Array(32);
    two[8] = 0.1; // −20 dB
    two[24] = 0.01; // −40 dB
    const lv = settleGain(createSpectroGain(32), two, 3);
    expect(lv[8]).toBeCloseTo(1, 5);
    expect(lv[24]).toBeGreaterThan(0.2);
    expect(lv[24]).toBeLessThan(0.75);
  });

  it("a quieter mix of the same shape normalises to the same levels", () => {
    const loud = new Float32Array(32).map((_, i) => 0.2 * Math.exp(-i / 8));
    const quiet = loud.map((v) => v * 0.25); // −12 dB
    const a = settleGain(createSpectroGain(32), loud, 3);
    const b = settleGain(createSpectroGain(32), quiet, 3);
    for (let i = 0; i < 16; i++) expect(b[i]).toBeCloseTo(a[i], 3); // well above the gate
  });

  it("the gain is slow: after a loud passage a drop reads low at once and recovers over seconds", () => {
    const g = createSpectroGain(4);
    settleGain(g, new Float32Array(4).fill(0.1), 2);
    const soft = new Float32Array(4).fill(0.01); // −20 dB
    const now = settleGain(g, soft, DT);
    expect(now[0]).toBeLessThan(0.45);
    const later = settleGain(g, soft, 8);
    expect(later[0]).toBeCloseTo(1, 3);
  });

  it("the pink tilt lifts highs and lowers the bass, 3 dB per octave around 1 kHz", () => {
    const lo = Float32Array.of(125, 1000, 8000);
    const hi = Float32Array.of(125, 1000, 8000);
    const g = createSpectroGain(3, { rangeDb: 60 });
    g.setTilt(lo, hi);
    const out = settleGain(g, new Float32Array(3).fill(0.01), 0.5);
    expect(out[0]).toBeLessThan(out[1]);
    expect(out[1]).toBeLessThan(out[2]);
  });
});

describe("riseSpeed", () => {
  it("is monotonic in level, bounded, and near zero at silence", () => {
    expect(riseSpeed(0, 1)).toBe(RISE_MIN);
    expect(RISE_MIN).toBeLessThan(0.1);
    expect(riseSpeed(1, 1)).toBeCloseTo(RISE_MAX, 6);
    expect(RISE_MAX).toBeGreaterThan(10 * RISE_MIN);
    let prev = 0;
    for (let l = 0; l <= 1.0001; l += 0.02) {
      const v = riseSpeed(l, 1);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(riseSpeed(3, 1)).toBeCloseTo(RISE_MAX, 6); // clamped
    expect(riseSpeed(-1, 1)).toBe(RISE_MIN);
    expect(riseSpeed(Number.NaN, 1)).toBe(RISE_MIN);
  });

  it("reactivity sets the contrast: 0 is linear in level, 2 holds quiet columns back harder", () => {
    for (const l of [0.25, 0.5, 0.75]) {
      expect(riseSpeed(l, 0)).toBeCloseTo(RISE_MIN + (RISE_MAX - RISE_MIN) * l, 6);
      expect(riseSpeed(l, 2)).toBeLessThan(riseSpeed(l, 1));
      expect(riseSpeed(l, 1)).toBeLessThan(riseSpeed(l, 0));
    }
    expect(riseSpeed(1, 2)).toBeCloseTo(RISE_MAX, 6);
  });
});
