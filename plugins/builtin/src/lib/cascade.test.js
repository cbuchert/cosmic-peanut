// @ts-check
import { describe, expect, it } from "vitest";
import manifest from "../../tidalviz.json";
import {
  buildInverseCdf,
  createEnvelopes,
  createSeed,
  createStepper,
  DEFAULT_DENSITY,
  DEFAULTS,
  DENSITIES,
  motionParams,
  resampleAbs,
  PALETTES,
  paletteRamp,
  paletteStops,
  sampleInverse,
  stateSize,
  triggerIndex,
} from "./cascade.js";

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

describe("triggerIndex (oscilloscope trigger)", () => {
  /** @param {number} shift samples @param {number} n */
  const tone = (shift, n = 2048) => {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i + shift;
      w[i] = 0.6 * Math.sin((2 * Math.PI * s) / 181) + 0.2 * Math.sin((2 * Math.PI * s) / 60.33);
    }
    return w;
  };

  it("pins a periodic waveform in place however its window is shifted", () => {
    const outA = new Float32Array(256);
    const outB = new Float32Array(256);
    const a = tone(0);
    const b = tone(97); // the next frame: same tone, different phase
    const ta = triggerIndex(a, 512);
    const tb = triggerIndex(b, 512);
    expect(ta).toBeGreaterThan(0);
    resampleAbs(a, outA, ta, 1536);
    resampleAbs(b, outB, tb, 1536);
    for (let i = 0; i < 256; i++) expect(outB[i]).toBeCloseTo(outA[i], 2);
  });

  it("starts the window at a rising zero crossing", () => {
    const w = tone(40);
    const t = triggerIndex(w, 512);
    expect(w[t - 1]).toBeLessThanOrEqual(0);
    expect(w[t]).toBeGreaterThan(0);
  });

  it("returns 0 when there is no crossing (silence, DC)", () => {
    expect(triggerIndex(new Float32Array(2048), 512)).toBe(0);
    expect(triggerIndex(new Float32Array(2048).fill(0.3), 512)).toBe(0);
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

describe("createSeed bass scaling", () => {
  it("scales the whole seed by the bass surge", () => {
    const lo = createSeed(256);
    const hi = createSeed(256);
    run(lo, jagged(0.5), 1, 0.5);
    run(hi, jagged(0.5), 1, 1.5);
    expect(hi.mean / lo.mean).toBeGreaterThan(2.5);
    expect(hi.mean / lo.mean).toBeLessThan(3.1);
  });
});

describe("createSeed rope persistence", () => {
  it("keeps distinct ropes for a tone whose phase drifts every frame (trigger-aligned)", () => {
    const s = createSeed(256);
    const w = new Float32Array(2048);
    for (let f = 0; f < 90; f++) {
      const shift = f * 512; // one 512-sample hop per frame
      for (let i = 0; i < 2048; i++) w[i] = 0.5 * Math.sin((2 * Math.PI * (i + shift)) / 301.7);
      s.update(w, 1 / 60, 1);
    }
    let mean = 0;
    for (const v of s.values) mean += v / 256;
    let varc = 0;
    for (const v of s.values) varc += (v - mean) ** 2 / 256;
    // Pinned and contrast-shaped (|sin|² has std/mean ≈ 0.71); phase-smeared it goes flat.
    expect(Math.sqrt(varc) / mean).toBeGreaterThan(0.6);
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

/** @param {Partial<{bassAtt: number, onset: boolean, onsetStrength: number}>} a */
const frameOf = (a) => ({ bassAtt: 1, onset: false, onsetStrength: 0, ...a });

describe("createEnvelopes", () => {
  it("surges the flow with bass, bounded for any input", () => {
    const quiet = createEnvelopes();
    const heavy = createEnvelopes();
    const wild = createEnvelopes();
    for (let t = 0; t < 1; t += 1 / 60) {
      quiet.step(frameOf({ bassAtt: 0.2 }), 1 / 60, true);
      heavy.step(frameOf({ bassAtt: 1.8 }), 1 / 60, true);
      wild.step(frameOf({ bassAtt: 50 }), 1 / 60, true);
    }
    expect(heavy.surge).toBeGreaterThan(quiet.surge * 1.8);
    expect(quiet.surge).toBeGreaterThanOrEqual(0.4);
    expect(wild.surge).toBeLessThanOrEqual(1.5);
  });
  it("pushes a bounded pulse on an onset that dies away within about half a second", () => {
    const e = createEnvelopes();
    e.step(frameOf({ onset: true, onsetStrength: 9 }), 1 / 60, false);
    expect(e.pulse).toBeGreaterThan(0.9);
    expect(e.pulse).toBeLessThanOrEqual(1);
    const weak = createEnvelopes();
    weak.step(frameOf({ onset: true, onsetStrength: 0.1 }), 1 / 60, false);
    expect(weak.pulse).toBeGreaterThan(0.2);
    expect(weak.pulse).toBeLessThan(e.pulse);
    for (let t = 0; t < 0.6; t += 1 / 60) e.step(frameOf({}), 1 / 60, false);
    expect(e.pulse).toBeLessThan(0.05);
    expect(e.pulse).toBeGreaterThanOrEqual(0);
  });
  it("with reduceFlashing, a 10 Hz onset strobe makes at most 3 pulse rises per second", () => {
    /** @param {boolean} reduce */
    const risesPerSecond = (reduce) => {
      const e = createEnvelopes();
      /** @type {number[]} */
      const starts = [];
      let lo = 0;
      let rising = false;
      let hi = 0;
      for (let f = 0; f < 240; f++) {
        e.step(frameOf({ onset: f % 6 === 0, onsetStrength: 1 }), 1 / 60, reduce);
        const v = e.pulse;
        if (!rising) {
          lo = Math.min(lo, v);
          if (v - lo >= 0.1) {
            starts.push(f / 60);
            rising = true;
            hi = v;
          }
        } else {
          hi = Math.max(hi, v);
          if (hi - v >= 0.1) {
            rising = false;
            lo = v;
          }
        }
      }
      let best = 0;
      for (const s0 of starts) best = Math.max(best, starts.filter((t) => t >= s0 && t - s0 < 1).length);
      return best;
    };
    expect(risesPerSecond(false)).toBeGreaterThanOrEqual(9);
    expect(risesPerSecond(true)).toBeLessThanOrEqual(3);
  });
});

describe("createStepper (fixed timestep)", () => {
  it("runs the same number of sim steps per second at 60 Hz and 120 Hz display rates", () => {
    const a = createStepper(120, 4);
    const b = createStepper(120, 4);
    let na = 0;
    let nb = 0;
    for (let f = 0; f < 60 * 3; f++) na += a.step(1 / 60);
    for (let f = 0; f < 120 * 3; f++) nb += b.step(1 / 120);
    expect(na).toBe(360);
    expect(nb).toBe(360);
    // Uneven frame times still add up.
    const c = createStepper(120, 4);
    let nc = 0;
    for (let f = 0; f < 100; f++) nc += c.step(f % 2 ? 0.011 : 0.022);
    expect(nc).toBe(Math.floor(((0.011 + 0.022) * 50 * 120) + 1e-9));
  });

  it("caps substeps after a long frame and drops the backlog instead of spiralling", () => {
    const s = createStepper(120, 4);
    expect(s.step(0.1)).toBe(4);
    expect(s.step(1 / 120)).toBe(1);
    expect(s.step(0)).toBe(0);
  });
});

describe("stateSize", () => {
  it("maps the density option to a particle count and a power-of-two-wide state texture", () => {
    expect(stateSize("16k")).toEqual({ count: 16384, width: 128, height: 128 });
    expect(stateSize("32k")).toEqual({ count: 32768, width: 256, height: 128 });
    expect(stateSize("64k")).toEqual({ count: 65536, width: 256, height: 256 });
  });

  it("falls back to the default for anything else", () => {
    expect(stateSize("lots")).toEqual(stateSize("32k"));
    expect(stateSize(undefined)).toEqual(stateSize("32k"));
  });
});

describe("palettes", () => {
  const lum = (/** @type {Float32Array} */ c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  it("offers glacier (default), tropical, moonlit and mono", () => {
    expect(PALETTES).toEqual(["glacier", "tropical", "moonlit", "mono"]);
    const unknown = paletteStops("neon", new Float32Array(12));
    expect([...unknown]).toEqual([...paletteStops("glacier", new Float32Array(12))]);
  });

  it("ramps from dim water to a near-white highlight, brightening monotonically", () => {
    const stops = new Float32Array(12);
    const c = new Float32Array(3);
    for (const name of PALETTES) {
      paletteStops(name, stops);
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const l = lum(paletteRamp(stops, t, c));
        expect(l, `${name} @ ${t}`).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = l;
      }
      expect(lum(paletteRamp(stops, 0, c)), name).toBeLessThan(0.3);
      paletteRamp(stops, 1, c);
      expect(Math.min(c[0], c[1], c[2]), name).toBeGreaterThan(0.8);
    }
  });

  it("keeps glacier white-blue and mono grey", () => {
    const stops = new Float32Array(12);
    const c = new Float32Array(3);
    paletteRamp(paletteStops("glacier", stops), 0.5, c);
    expect(c[2]).toBeGreaterThan(c[0]);
    paletteRamp(paletteStops("mono", stops), 0.4, c);
    expect(c[0]).toBeCloseTo(c[1], 6);
    expect(c[1]).toBeCloseTo(c[2], 6);
  });
});

describe("motionParams (reduceMotion)", () => {
  const out = { spray: 0, turbulence: 0 };

  it("passes spray and turbulence through when reduceMotion is off", () => {
    motionParams({ spray: DEFAULTS.spray, turbulence: DEFAULTS.turbulence }, false, out);
    expect(out).toEqual({ spray: DEFAULTS.spray, turbulence: DEFAULTS.turbulence });
  });

  it("calms spray and turbulence left at their defaults when reduceMotion is on", () => {
    motionParams({ spray: DEFAULTS.spray, turbulence: DEFAULTS.turbulence }, true, out);
    expect(out.spray).toBeLessThan(DEFAULTS.spray * 0.6);
    expect(out.spray).toBeGreaterThan(0);
    expect(out.turbulence).toBeLessThan(DEFAULTS.turbulence * 0.5);
  });

  it("respects values the user chose, even with reduceMotion", () => {
    motionParams({ spray: 0.9, turbulence: 0.8 }, true, out);
    expect(out).toEqual({ spray: 0.9, turbulence: 0.8 });
  });
});

describe("manifest agreement", () => {
  const entry = manifest.visualizers.find((v) => v.id === "cascade");
  /** @param {string} id */
  const param = (id) => /** @type {any} */ (entry?.params?.find((p) => p.id === id));

  it("uses the manifest defaults for the reduceMotion rule, palettes and densities", () => {
    expect(param("spray").default).toBe(DEFAULTS.spray);
    expect(param("turbulence").default).toBe(DEFAULTS.turbulence);
    expect(param("palette").options).toEqual(PALETTES);
    expect(param("palette").default).toBe(PALETTES[0]);
    expect(param("density").options).toEqual(Object.keys(DENSITIES));
    expect(param("density").default).toBe(DEFAULT_DENSITY);
  });
});
