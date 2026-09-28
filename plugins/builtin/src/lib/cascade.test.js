// @ts-check
import { describe, expect, it } from "vitest";
import { buildInverseCdf, createSeed, resampleAbs, sampleInverse } from "./cascade.js";

describe("resampleAbs", () => {
  it("point-samples |w| with linear interpolation at every output texel (no averaging)", () => {
    const wave = new Float32Array([0, -1, 0.5, 0, -0.25]);
    const out = new Float32Array(9);
    resampleAbs(wave, out);
    // Output texel i sits at input position i * (5 - 1) / (9 - 1) = i / 2.
    const want = [0, 0.5, 1, 0.75, 0.5, 0.25, 0, 0.125, 0.25];
    for (let i = 0; i < want.length; i++) expect(out[i]).toBeCloseTo(want[i], 6);
  });

  it("maps the ends of any input length onto the ends of the output, keeping single-sample spikes", () => {
    for (const n of [2048, 1000, 4096, 257]) {
      const wave = new Float32Array(n);
      wave[0] = -0.3;
      wave[n - 1] = 0.9;
      // A one-sample spike exactly on a texel's input position must come through at full height.
      const m = 256;
      const hit = Math.round((100 * (n - 1)) / (m - 1));
      const exact = (100 * (n - 1)) / (m - 1) === hit;
      wave[hit] = -1;
      const out = resampleAbs(wave, new Float32Array(m));
      expect(out[0]).toBeCloseTo(0.3, 6);
      expect(out[m - 1]).toBeCloseTo(0.9, 6);
      if (exact) expect(out[100]).toBeCloseTo(1, 6);
      else expect(out[100]).toBeGreaterThan(0.4);
    }
  });

  it("gives all zeros for an empty waveform and a constant for a single sample", () => {
    expect([...resampleAbs(new Float32Array(0), new Float32Array(4).fill(7))]).toEqual([0, 0, 0, 0]);
    expect([...resampleAbs(new Float32Array([-0.5]), new Float32Array(3))]).toEqual([0.5, 0.5, 0.5]);
  });
});

/** @param {number} n @param {number} v */
const flat = (n, v) => new Float32Array(n).fill(v);

describe("createSeed smoothing", () => {
  it("smooths each texel over a few frames, the same at 60 and 120 Hz", () => {
    const a = createSeed(64);
    const b = createSeed(64);
    const loud = flat(2048, 0.8);
    a.update(loud, 1 / 60, 1);
    // One 60 Hz frame moves part of the way, not all of it: ropes persist a little.
    expect(a.smooth[10]).toBeGreaterThan(0.2);
    expect(a.smooth[10]).toBeLessThan(0.7);
    b.update(loud, 1 / 120, 1);
    b.update(loud, 1 / 120, 1);
    expect(b.smooth[10]).toBeCloseTo(a.smooth[10], 5);
    // Within ~0.15 s it has caught up.
    for (let i = 0; i < 8; i++) a.update(loud, 1 / 60, 1);
    expect(a.smooth[10]).toBeGreaterThan(0.78);
  });
});

/**
 * A jagged test waveform: a sawtooth-ish shape with a sharp spike, scaled by `amp`.
 * @param {number} amp
 */
function jagged(amp, n = 2048) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = amp * (((i * 7) % 256) / 256 - 0.5) * 2;
  return w;
}

/** @param {ReturnType<typeof createSeed>} s @param {Float32Array} wave @param {number} seconds */
function run(s, wave, seconds, surge = 1) {
  for (let t = 0; t < seconds; t += 1 / 60) s.update(wave, 1 / 60, surge);
}

describe("createSeed auto-gain", () => {
  it("normalises a moderate and a loud passage to the same full-height seed, keeping the shape", () => {
    const loud = createSeed(256);
    const soft = createSeed(256);
    run(loud, jagged(0.8), 4);
    run(soft, jagged(0.2), 4);
    const peak = (/** @type {Float32Array} */ v) => v.reduce((m, x) => Math.max(m, x), 0);
    expect(peak(loud.values)).toBeGreaterThan(0.9);
    expect(peak(soft.values)).toBeGreaterThan(0.9);
    for (let i = 0; i < 256; i += 17) expect(soft.values[i]).toBeCloseTo(loud.values[i], 1);
    expect(peak(loud.values)).toBeLessThanOrEqual(1.0001);
  });
});

describe("createSeed quiet and silence", () => {
  it("thins to a trickle right after a loud passage turns quiet", () => {
    const s = createSeed(256);
    run(s, jagged(0.8), 3);
    const loudMean = s.mean;
    run(s, jagged(0.02), 0.3);
    expect(s.mean).toBeLessThan(loudMean * 0.2);
  });

  it("keeps a thin, moving trickle in silence: never all zero, never frozen", () => {
    const s = createSeed(256);
    run(s, new Float32Array(2048), 2);
    const before = Float32Array.from(s.values);
    expect(s.mean).toBeGreaterThan(0.002);
    expect(s.mean).toBeLessThan(0.06);
    run(s, new Float32Array(2048), 2);
    let diff = 0;
    for (let i = 0; i < 256; i++) diff += Math.abs(s.values[i] - before[i]);
    expect(diff / 256).toBeGreaterThan(0.001);
  });
});

/** Deterministic uniform [0, 1) generator for statistical tests. */
function rng(seed = 7) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Histogram of lip positions drawn the way the respawn shader draws them.
 * @param {Float32Array} seed @param {number} draws
 */
function spawnHistogram(seed, draws = 200000) {
  const inv = buildInverseCdf(seed, new Float32Array(512));
  const hist = new Float64Array(seed.length);
  const r = rng();
  for (let k = 0; k < draws; k++) {
    const x = sampleInverse(inv, r());
    hist[Math.min(seed.length - 1, Math.floor(x * seed.length))] += 1 / draws;
  }
  return hist;
}

describe("lip distribution (inverse CDF)", () => {
  it("spawns proportionally more water where a peaked seed is large", () => {
    const seed = new Float32Array(256).fill(0.05);
    for (let i = 100; i <= 110; i++) seed[i] = 1;
    const hist = spawnHistogram(seed);
    let inPeak = 0;
    for (let i = 100; i <= 110; i++) inPeak += hist[i];
    expect(inPeak).toBeCloseTo(11 / (11 + 245 * 0.05), 2);
    // Per texel: the peak texels each get 20x a floor texel.
    expect(hist[105] / hist[30]).toBeGreaterThan(17);
    expect(hist[105] / hist[30]).toBeLessThan(23);
  });

  it("follows an arbitrary jagged seed texel by texel", () => {
    const seed = new Float32Array(64);
    for (let i = 0; i < 64; i++) seed[i] = 0.1 + ((i * 37) % 11) / 10;
    const total = seed.reduce((a, b) => a + b, 0);
    const hist = spawnHistogram(seed, 400000);
    for (let i = 0; i < 64; i++) expect(Math.abs(hist[i] - seed[i] / total)).toBeLessThan(0.0025);
  });

  it("falls back to uniform for an all-zero seed", () => {
    const hist = spawnHistogram(new Float32Array(32));
    for (let i = 0; i < 32; i++) expect(hist[i]).toBeCloseTo(1 / 32, 2);
  });
});
