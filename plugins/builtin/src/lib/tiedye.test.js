// @ts-check
import { describe, expect, it } from "vitest";
import {
  BLOOM_CAP,
  BLOOM_SPREAD,
  createArmWarp,
  WARP_N,
  PALETTES,
  PATTERNS,
  FABRICS,
  paletteOf,
  patternIndex,
  fabricIndex,
  MAX_COLORS,
  bandCoord,
  bandOf,
  edgesFromWidths,
  createBandWidths, createBlooms, createSpin, DEFAULT_SPEED, TWIST_DEPTH } from "./tiedye.js";

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

describe("createBlooms", () => {
  /** Active blooms: those with amount > 0. */
  const active = (/** @type {ReturnType<typeof createBlooms>} */ b) => {
    let n = 0;
    for (let i = 0; i < BLOOM_CAP; i++) if (b.data[i * 4 + 3] > 0) n++;
    return n;
  };

  it("drops a bloom on an onset, and none without", () => {
    const b = createBlooms(1);
    for (let f = 0; f < 30; f++) b.step(false, 0, 1 / 60);
    expect(active(b)).toBe(0);
    b.step(true, 1, 1 / 60);
    b.step(false, 0, 1 / 60);
    expect(active(b)).toBe(1);
  });

  /** Positions of the first `n` blooms, one onset every 0.5 s. */
  const spots = (/** @type {number} */ seed, n = 4) => {
    const b = createBlooms(seed);
    /** @type {number[]} */
    const out = [];
    for (let k = 0; k < n; k++) {
      b.step(true, 1, 1 / 60);
      out.push(b.data[k * 4], b.data[k * 4 + 1]);
      for (let f = 0; f < 30; f++) b.step(false, 0, 1 / 60);
    }
    return out;
  };

  it("places blooms deterministically from the seed, inside the spread disc", () => {
    expect(spots(7)).toEqual(spots(7));
    expect(spots(7)).not.toEqual(spots(8));
    const p = spots(3, 8);
    for (let k = 0; k < 8; k++) expect(Math.hypot(p[2 * k], p[2 * k + 1])).toBeLessThanOrEqual(BLOOM_SPREAD);
    expect(new Set(p).size).toBe(16);
  });

  it("caps the pool, recycling the oldest bloom", () => {
    const b = createBlooms(1);
    for (let k = 0; k < 20; k++) {
      b.step(true, 1, 1 / 60);
      b.step(false, 0, 1 / 60);
    }
    expect(b.data.length).toBe(BLOOM_CAP * 4);
    expect(active(b)).toBe(BLOOM_CAP);
    // Slot 20 % CAP holds the oldest (spawned 2 × CAP frames ago); the next onset replaces it.
    const oldest = (20 % BLOOM_CAP) * 4;
    const before = b.data[oldest + 2];
    b.step(true, 1, 1 / 60);
    expect(b.data[oldest + 2]).toBeLessThan(before);
  });

  it("bleeds outward (radius grows) and fades out within ~2 s", () => {
    const b = createBlooms(1);
    b.step(true, 1, 1 / 60);
    let r = b.data[2];
    let peak = 0;
    for (let f = 1; f < 150; f++) {
      b.step(false, 0, 1 / 60);
      expect(b.data[2] === 0 || b.data[2] >= r).toBe(true);
      if (b.data[2] > 0) r = b.data[2];
      peak = Math.max(peak, b.data[3]);
      if (f === 30) expect(b.data[3]).toBeGreaterThan(0.5);
    }
    expect(r).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
    expect(b.data[3]).toBe(0);
    expect(active(b)).toBe(0);
  });
});

describe("createArmWarp", () => {
  const settleWarp = (/** @type {Float32Array} */ wave, frames = 60) => {
    const w = createArmWarp();
    let out = w.step(wave, 1 / 60);
    for (let f = 1; f < frames; f++) out = w.step(wave, 1 / 60);
    return out;
  };

  it("stays within -1..1 however loud the waveform", () => {
    const wave = new Float32Array(2048);
    for (let i = 0; i < wave.length; i++) wave[i] = i % 7 < 3 ? 40 : -40;
    const out = settleWarp(wave);
    expect(out.length).toBe(WARP_N);
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(0.5);
  });

  it("keeps the jaggedness of busy audio when resampling (peaks, not averages)", () => {
    // A 3 kHz tone at 48 kHz: 16-sample period, so every bucket averages to ~0.
    const wave = new Float32Array(2048);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.6 * Math.sin((2 * Math.PI * i) / 16);
    const out = settleWarp(wave);
    let mean = 0;
    for (const v of out) mean += Math.abs(v) / WARP_N;
    expect(mean).toBeGreaterThan(0.3);
  });

  it("reads the waveform's length (any size)", () => {
    const wave = new Float32Array(1000).fill(0.4);
    const out = settleWarp(wave);
    for (const v of out) expect(v).toBeCloseTo(0.4, 2);
  });

  it("wobbles rather than flickers: a waveform flipping sign every frame barely moves the arms", () => {
    const up = new Float32Array(2048).fill(0.8);
    const down = new Float32Array(2048).fill(-0.8);
    const w = createArmWarp();
    let out = w.step(up, 1 / 60);
    for (let f = 1; f < 120; f++) out = w.step(f % 2 ? down : up, 1 / 60);
    expect(Math.abs(out[0])).toBeLessThan(0.3);
    // …while a sustained shape comes through within a fraction of a second.
    for (let f = 0; f < 15; f++) out = w.step(up, 1 / 60);
    expect(out[0]).toBeGreaterThan(0.6);
  });
});

describe("selection", () => {
  it("maps each pattern and fabric option to its shader index, unknown → the default", () => {
    expect(PATTERNS).toEqual(["spiral", "bullseye", "crumple", "shibori"]);
    PATTERNS.forEach((p, i) => expect(patternIndex(p)).toBe(i));
    expect(patternIndex("paisley")).toBe(0);
    expect(FABRICS).toEqual(["white", "none"]);
    expect(fabricIndex("none")).toBe(1);
    expect(fabricIndex(undefined)).toBe(0);
  });

  it("gives each palette 4–MAX_COLORS saturated, distinct dye colors; unknown → rainbow", () => {
    expect(PALETTES).toEqual(["rainbow", "sunset", "ocean", "neon"]);
    const out = new Float32Array(MAX_COLORS * 3);
    /** @type {string[]} */
    const seen = [];
    for (const name of PALETTES) {
      const n = paletteOf(name, out);
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(MAX_COLORS);
      for (let i = 0; i < n; i++) {
        const c = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
        expect(Math.max(...c) - Math.min(...c), `${name} ${i}`).toBeGreaterThan(0.35);
      }
      seen.push(out.slice(0, n * 3).join());
    }
    expect(new Set(seen).size).toBe(PALETTES.length);
    expect(paletteOf("plaid", out)).toBe(paletteOf("rainbow", out));
  });
});

describe("band index (mirror of tiedye.frag)", () => {
  const n = 6;
  const edges = edgesFromWidths(new Float32Array([0.1, 0.3, 0.1, 0.2, 0.15, 0.15]), n, new Float32Array(MAX_COLORS + 1));
  const band = (/** @type {number} */ p, /** @type {number} */ r, /** @type {number} */ a, twist = 1.5, turns = 0) =>
    bandOf(bandCoord(p, r * Math.cos(a), r * Math.sin(a), twist, turns), edges, n);

  it("turns widths into cumulative edges from 0 to one full turn", () => {
    expect(Array.from(edges.slice(0, n + 1)).map((x) => +x.toFixed(4))).toEqual([0, 0.1, 0.4, 0.5, 0.7, 0.85, 1]);
    expect(bandOf(0.05, edges, n)).toBe(0);
    expect(bandOf(0.45, edges, n)).toBe(2);
    expect(bandOf(0.999, edges, n)).toBe(5);
  });

  it("spiral: the band changes with angle, and twists with radius", () => {
    const around = new Set();
    for (let k = 0; k < 64; k++) around.add(band(0, 0.5, (2 * Math.PI * k) / 64));
    expect(around.size).toBe(n);
    // Along a ray the band changes only when twisted.
    const ray = (/** @type {number} */ twist) => {
      const s = new Set();
      for (let k = 1; k < 40; k++) s.add(band(0, k / 40, 0.3, twist));
      return s.size;
    };
    expect(ray(0)).toBe(1);
    expect(ray(1.5)).toBeGreaterThan(3);
    // Rotation turns the whole pattern.
    expect(band(0, 0.5, 0.3, 1.5, 0.25)).toBe(band(0, 0.5, 0.3 + Math.PI / 2, 1.5, 0));
  });

  it("bullseye: the band depends on radius only", () => {
    for (const r of [0.1, 0.33, 0.6, 0.9]) {
      const b = band(1, r, 0, 1.5, 0.3);
      for (let k = 1; k < 16; k++) expect(band(1, r, (2 * Math.PI * k) / 16, 1.5, 0.3)).toBe(b);
    }
    const out = new Set();
    for (let k = 0; k < 50; k++) out.add(band(1, k / 50, 0));
    expect(out.size).toBe(n);
  });

  it("shibori: accordion-folded stripes, mirror-symmetric across each fold", () => {
    const t = (/** @type {number} */ x) => bandCoord(3, x, 0.2, 1.5, 0);
    const across = new Set();
    for (let k = 0; k < 100; k++) across.add(bandOf(t(k / 100), edges, n));
    expect(across.size).toBe(n);
    for (const x of [0.03, 0.11, 0.07]) expect(t(-x)).toBeCloseTo(t(x), 5);
  });
});
