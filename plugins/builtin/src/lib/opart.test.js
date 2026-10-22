// @ts-check
import { describe, expect, it } from "vitest";
import {
  BASE_K,
  BREATHE,
  createRipples,
  createRippleTrigger,
  createStripeDrive,
  createThickness,
  createWaveBend,
  DRIVE_BUDGET,
  MAX_ALT_HZ,
  RATE_BUDGET,
  createEnergy,
  createPhrase,
  PHRASE_BEATS,
  REVERSE_RATE,
  DUTY_MAX,
  FIELD_MAX,
  FLOW_SENS,
  lookColors,
  loudness,
  opField,
  resolveLook,
  RIPPLE_SPEED,
  TWIST_MAX,
  TWIST_SENS,
  stripe,
  WAVE_PHASE,
  WAVE_RESERVE,
  WAVE_SLEW,
} from "./opart.js";
import { CAM_DIST, screenRadius } from "./skull-bounds.js";
import { PULSE_LIMIT, TILT_LIMIT } from "./skull-motion.js";

describe("stripe (anti-aliased sign of sin)", () => {
  it("is 0 on black, 1 on white, with a monotonic ramp across each edge", () => {
    const w = 0.05;
    let prev = -1;
    for (let v = -1; v <= 1; v += 0.001) {
      const s = stripe(v, w, 0);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(stripe(-0.2, w, 0)).toBe(0);
    expect(stripe(0.2, w, 0)).toBe(1);
    expect(stripe(0, w, 0)).toBeCloseTo(0.5, 6);
  });
});

/**
 * Violent, random drive input: pumping bass and energy, beat surges, the swirl flipping direction.
 * @param {{ density?: number, speed?: number, warp?: number }} [knobs] max params by default
 */
function violentInput(knobs = {}) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const input = { density: 2, speed: 2, warp: 2, reactivity: 2, bassAtt: 1, energy: 1, surge: 0, dir: 1, ...knobs };
  return {
    input,
    next() {
      input.bassAtt = rnd() < 0.5 ? 0 : 3;
      input.energy = rnd() * 3;
      input.surge = rnd() < 0.2 ? 1 : input.surge * 0.9;
      if (rnd() < 0.01) input.dir = -input.dir;
    },
  };
}

/**
 * Most stripe inversions (black↔white flips) any pixel sees in a 1 s window from the drive. A pixel
 * at field value F has phase P = freq·F − phase; its field moves with the flow at up to
 * FLOW_SENS·warp per unit of flow and with the twist at up to TWIST_SENS per radian (either sign).
 * @param {number} hz @param {number} seconds @param {boolean} reduceFlashing
 * @param {{ density?: number, speed?: number, warp?: number }} [knobs]
 */
function worstInversions(hz, seconds, reduceFlashing, knobs) {
  let worst = 0;
  for (const F of [0, 0.5 * FIELD_MAX, FIELD_MAX]) {
    for (const s of [-1, 0, 1]) {
      for (const t of [-1, 1]) {
        const d2 = createStripeDrive();
        const v2 = violentInput(knobs);
        let P = 0.1; // just off an edge
        const flips = [];
        let prev = { phase: d2.phase, freq: d2.freq, flow: d2.flow, twist: d2.twist };
        for (let f = 0; f < hz * seconds; f++) {
          v2.next();
          d2.step(1 / hz, v2.input, reduceFlashing);
          const dP =
            (d2.freq - prev.freq) * F +
            d2.freq * (s * FLOW_SENS * v2.input.warp * (d2.flow - prev.flow) + t * TWIST_SENS * (d2.twist - prev.twist)) -
            (d2.phase - prev.phase);
          const before = Math.floor(P / Math.PI);
          P += dP;
          const after = Math.floor(P / Math.PI);
          for (let n = 0; n < Math.abs(after - before); n++) flips.push(f / hz);
          prev = { phase: d2.phase, freq: d2.freq, flow: d2.flow, twist: d2.twist };
        }
        for (let i = 0; i < flips.length; i++) {
          let n = 0;
          while (i + n < flips.length && flips[i + n] - flips[i] < 1) n++;
          worst = Math.max(worst, n);
        }
      }
    }
  }
  return worst;
}

describe("createStripeDrive anti-strobe", () => {
  it("with reduceFlashing, keeps every pixel within DRIVE_BUDGET of phase a second at any density, speed and warp", () => {
    const most = Math.floor(DRIVE_BUDGET / Math.PI) + 1; // flips a 1 s window can hold at that rate
    expect(2 * MAX_ALT_HZ * Math.PI * 0.9).toBeCloseTo(RATE_BUDGET, 9);
    for (const density of [0.5, 1, 2])
      for (const speed of [0, 1, 2])
        for (const warp of [0, 1, 2])
          for (const hz of [60, 120]) expect(worstInversions(hz, 4, true, { density, speed, warp }), `${density} ${speed} ${warp} ${hz} Hz`).toBeLessThanOrEqual(most);
  });

  it("without reduceFlashing, max params may flow faster", () => {
    expect(worstInversions(60, 4, false)).toBeGreaterThan(Math.floor(DRIVE_BUDGET / Math.PI) + 1);
  });
});

describe("createStripeDrive breathing", () => {
  it("packs the stripes tighter on heavy bass and loosens them when it drops, within ±BREATHE/2", () => {
    const d = createStripeDrive();
    const input = { density: 1, speed: 1, warp: 0, reactivity: 1, bassAtt: 2, energy: 1, surge: 0, dir: 1 };
    for (let f = 0; f < 480; f++) d.step(1 / 60, input, true);
    const hi = d.freq;
    input.bassAtt = 0;
    for (let f = 0; f < 480; f++) d.step(1 / 60, input, true);
    expect(hi).toBeGreaterThan(BASE_K * (1 + 0.4 * BREATHE));
    expect(hi).toBeLessThanOrEqual(BASE_K * (1 + 0.5 * BREATHE) + 1e-9);
    expect(d.freq).toBeLessThan(BASE_K * (1 - 0.4 * BREATHE));
    expect(d.freq).toBeGreaterThanOrEqual(BASE_K * (1 - 0.5 * BREATHE) - 1e-9);
  });
});

describe("createThickness", () => {
  it("thickens stripes on bass hits, bounded by DUTY_MAX, and with reduceFlashing starts at most 3 swells a second", () => {
    for (const reduce of [false, true]) {
      const t = createThickness();
      let rises = 0;
      let prev = 0;
      let rising = false;
      for (let f = 0; f < 60 * 4; f++) {
        const bass = f % 6 === 0 ? 3 : 0.2; // 10 Hz bass strobe
        const v = t.step(bass, 2, 1 / 60, reduce);
        expect(Math.abs(v)).toBeLessThanOrEqual(DUTY_MAX);
        if (v > prev + 1e-6 && !rising) rises++;
        rising = v > prev + 1e-6;
        prev = v;
      }
      if (reduce) expect(rises / 4).toBeLessThanOrEqual(3);
      else expect(rises / 4).toBeGreaterThan(3);
    }
  });
});

describe("createRipples ring buffer", () => {
  it("launches a ring whose radius grows with time while it fades out", () => {
    const r = createRipples(4);
    r.spawn(1);
    const seen = [];
    for (let f = 0; f < 60 * 4; f++) {
      r.step(1 / 60);
      seen.push([r.data[0], r.data[1]]);
    }
    expect(seen[59][0]).toBeCloseTo(RIPPLE_SPEED * 1, 5);
    expect(seen[119][0]).toBeCloseTo(RIPPLE_SPEED * 2, 5);
    expect(seen[0][1]).toBeGreaterThan(0.9);
    for (let i = 1; i < seen.length; i++) expect(seen[i][1]).toBeLessThanOrEqual(seen[i - 1][1]);
    expect(seen[seen.length - 1][1]).toBe(0);
  });

  it("keeps at most `cap` rings, replacing the oldest", () => {
    const r = createRipples(4);
    for (let i = 0; i < 6; i++) {
      r.spawn(1);
      r.step(0.1);
    }
    const radii = [];
    for (let i = 0; i < 4; i++) radii.push(r.data[2 * i]);
    radii.sort((a, b) => a - b);
    expect(r.data.length).toBe(8);
    expect(radii[0]).toBeCloseTo(RIPPLE_SPEED * 0.1, 5);
    expect(radii[3]).toBeCloseTo(RIPPLE_SPEED * 0.4, 5);
  });
});

describe("createRippleTrigger", () => {
  it("launches a ripple per onset, sized by its strength; with reduceFlashing at most 3 a second", () => {
    for (const reduce of [false, true]) {
      const t = createRippleTrigger();
      let n = 0;
      for (let f = 0; f < 60 * 4; f++) {
        const s = t.step(f % 6 === 0, 1, 1, 1 / 60, reduce); // 10 Hz onsets
        if (s > 0) {
          n++;
          expect(s).toBeLessThanOrEqual(1);
        }
      }
      if (reduce) expect(n / 4).toBeLessThanOrEqual(3);
      else expect(n / 4).toBeCloseTo(10, 0);
    }
  });

  it("stays quiet without onsets and scales with the gain", () => {
    const t = createRippleTrigger();
    expect(t.step(false, 1, 1, 1 / 60, true)).toBe(0);
    const weak = createRippleTrigger().step(true, 1, 0.3, 1 / 60, true);
    const full = createRippleTrigger().step(true, 1, 1, 1 / 60, true);
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeCloseTo(0.3 * full, 5);
  });
});

describe("createWaveBend", () => {
  it("follows the waveform's shape, bounded, slew-limited, from any waveform length", () => {
    for (const len of [2048, 512]) {
      const b = createWaveBend(32);
      const wave = new Float32Array(len);
      let prev = new Float32Array(32);
      for (let f = 0; f < 120; f++) {
        for (let i = 0; i < len; i++) wave[i] = (f % 2 ? 1 : -1) * Math.sin((Math.PI * i) / len);
        const out = b.step(wave, 1 / 60);
        for (let i = 0; i < 32; i++) {
          expect(Math.abs(out[i])).toBeLessThanOrEqual(1);
          expect(Math.abs(out[i] - prev[i]) * 60).toBeLessThanOrEqual(WAVE_SLEW + 1e-6);
        }
        prev = out.slice();
      }
      // A steady waveform is followed: a half-sine hump, largest mid-way.
      for (let i = 0; i < len; i++) wave[i] = 0.4 * Math.sin((Math.PI * i) / len);
      let out = b.step(wave, 1 / 60);
      for (let f = 0; f < 120; f++) out = b.step(wave, 1 / 60);
      expect(out[16]).toBeGreaterThan(out[1]);
      expect(out[16]).toBeGreaterThan(0.3);
    }
  });

  it("fits the reserved phase budget", () => {
    expect(WAVE_PHASE * WAVE_SLEW).toBeLessThanOrEqual(WAVE_RESERVE);
  });
});

describe("resolveLook", () => {
  const out = { acid: true, paperAlpha: 0 };
  it("defaults to monochrome black & white", () => {
    expect(resolveLook("monochrome", "black & white", out)).toEqual({ acid: false, paperAlpha: 1 });
  });
  it("selects acid tints and the transparent 'black only' paper", () => {
    expect(resolveLook("acid", "black only", out)).toEqual({ acid: true, paperAlpha: 0 });
  });
  it("falls back to the defaults for unknown values", () => {
    expect(resolveLook("plaid", 7, out)).toEqual({ acid: false, paperAlpha: 1 });
  });
});

describe("lookColors", () => {
  const luma = (/** @type {Float32Array} */ c, /** @type {number} */ o) => 0.2126 * c[o] + 0.7152 * c[o + 1] + 0.0722 * c[o + 2];

  it("is pure black ink on white paper in monochrome", () => {
    const c = new Float32Array(6);
    lookColors(false, 12.3, c);
    expect([...c]).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("acid tints shift slowly, keep strong ink/paper contrast, and change colour over time", () => {
    const c = new Float32Array(6);
    const prev = new Float32Array(6);
    lookColors(true, 0, prev);
    const first = prev.slice();
    let moved = 0;
    for (let f = 1; f < 60 * 40; f++) {
      lookColors(true, f / 60, c);
      expect(luma(c, 3) - luma(c, 0)).toBeGreaterThan(0.45);
      for (let i = 0; i < 6; i++) {
        expect(c[i]).toBeGreaterThanOrEqual(0);
        expect(c[i]).toBeLessThanOrEqual(1);
        expect(Math.abs(c[i] - prev[i])).toBeLessThan(0.01);
        moved = Math.max(moved, Math.abs(c[i] - first[i]));
      }
      prev.set(c);
    }
    expect(moved).toBeGreaterThan(0.3);
  });
});

describe("createWaveBend robustness", () => {
  it("ignores non-finite samples instead of getting stuck on NaN", () => {
    const b = createWaveBend(8);
    const wave = new Float32Array(64).fill(0.3);
    wave[3] = NaN;
    wave[40] = Infinity;
    let out = b.step(wave, 1 / 60);
    for (let f = 0; f < 60; f++) out = b.step(wave, 1 / 60);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

/**
 * Random field states and screen points (half the short side is 1, the long side up to 21:9 either
 * way round, every skull size, tilt and jaw) and whether the point is outside the skull's bounding
 * circle (inside, the skull covers the stripes).
 * @param {number} seed
 * @param {(x: number, y: number, s: import("./opart.js").FieldState, outside: boolean) => void} fn
 */
function sampleField(seed, fn) {
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 6000; i++) {
    const size = 0.5 + rnd();
    const outline = [(FOCAL / CAM_DIST) * size * (1 + PULSE_LIMIT * rnd()), (rnd() * 2 - 1) * TILT_LIMIT, rnd() * 0.33];
    const long = (rnd() * 2 - 1) * 2.4;
    const short = rnd() * 2 - 1;
    const [x, y] = i % 2 ? [long, short] : [short, long];
    const warp = 0.05 + rnd() * 1.95;
    const s = { flow: rnd() * 1000, warp, outline, twist: (rnd() * 2 - 1) * TWIST_MAX * warp };
    fn(x, y, s, Math.hypot(x, y) > screenRadius(1 + PULSE_LIMIT, FOCAL * size));
  }
}
const FOCAL = 3.3; // src/skull.js

describe("opField (mirror of opart.glsl)", () => {
  it("stays within FIELD_MAX on any screen and, outside the skull, moves with the flow no faster than FLOW_SENS per unit of warp", () => {
    let worst = 0;
    sampleField(3, (x, y, s, outside) => {
      const f = opField(x, y, s);
      expect(Math.abs(f)).toBeLessThanOrEqual(FIELD_MAX);
      const h = 1e-4;
      if (outside) worst = Math.max(worst, Math.abs(opField(x, y, { ...s, flow: s.flow + h }) - f) / h / s.warp);
    });
    expect(worst).toBeLessThanOrEqual(FLOW_SENS);
    expect(worst).toBeGreaterThan(0.5 * FLOW_SENS); // the bound isn't wildly loose
  });
});

describe("opField swirl (mirror of opart.glsl)", () => {
  it("outside the skull, moves with the twist no faster than TWIST_SENS", () => {
    let worst = 0;
    sampleField(5, (x, y, s, outside) => {
      if (!outside) return;
      const h = 1e-4;
      worst = Math.max(worst, Math.abs(opField(x, y, { ...s, twist: (s.twist ?? 0) + h }) - opField(x, y, s)) / h);
    });
    expect(worst).toBeLessThanOrEqual(TWIST_SENS);
    expect(worst).toBeGreaterThan(0.5 * TWIST_SENS);
  });
});

describe("loudness (rms → 0–1 drive level)", () => {
  it("is 0 in silence, rises monotonically with the level in dB, and saturates at 1 for loud music", () => {
    expect(loudness(0)).toBe(0);
    expect(loudness(NaN)).toBe(0);
    expect(loudness(0.003)).toBe(0); // ≈ −50 dBFS: room noise
    let prev = 0;
    for (let db = -60; db <= 0; db += 1) {
      const v = loudness(10 ** (db / 20));
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(loudness(0.02)).toBeLessThan(0.35); // a quiet passage (≈ −34 dBFS)
    expect(loudness(0.25)).toBe(1); // loud, mastered music (≈ −12 dBFS)
  });
});

/** Steady audio at an rms level, with average bass. @param {number} rms */
const steady = (rms) => ({ rms, bassAtt: rms > 0 ? 1 : 0, onset: false, onsetStrength: 0, silent: rms === 0 });

describe("createEnergy", () => {
  it("settles high for loud music, low for a quiet passage, at 0 in silence", () => {
    /** @param {number} rms */
    const settle = (rms) => {
      const e = createEnergy();
      for (let f = 0; f < 600; f++) e.step(steady(rms), 1 / 60);
      return e.level;
    };
    expect(settle(0)).toBe(0);
    expect(settle(0.3)).toBeGreaterThan(0.9);
    expect(settle(0.02)).toBeLessThan(0.35);
    expect(settle(0.3)).toBeGreaterThan(3 * settle(0.02));
  });
});

describe("createEnergy beat surge", () => {
  it("surges on an onset in proportion to its strength, decays within a beat, the same at 60 and 120 Hz", () => {
    /** @param {number} strength @param {number} hz */
    const run = (strength, hz) => {
      const e = createEnergy();
      const a = steady(0.3);
      const trace = [];
      for (let f = 0; f < hz; f++) {
        a.onset = f === hz / 4;
        a.onsetStrength = a.onset ? strength : 0;
        e.step(a, 1 / hz);
        expect(e.surge).toBeGreaterThanOrEqual(0);
        expect(e.surge).toBeLessThanOrEqual(1);
        if (f % (hz / 60) === hz / 60 - 1) trace.push(e.surge);
      }
      return trace;
    };
    const strong = run(1, 60);
    const weak = run(0.3, 60);
    expect(Math.max(...strong.slice(0, 14))).toBe(0);
    expect(Math.max(...strong)).toBeGreaterThan(0.9);
    expect(Math.max(...weak)).toBeCloseTo(0.3, 1);
    expect(strong[15 + 30]).toBeLessThan(0.15); // half a second later
    const fast = run(1, 120);
    for (let i = 16; i < 60; i++) expect(fast[i]).toBeCloseTo(strong[i], 1);
  });
});

describe("createPhrase swirl direction", () => {
  it("with a confident tempo, reverses smoothly every PHRASE_BEATS beats, the same at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const run = (hz) => {
      const p = createPhrase();
      const trace = [];
      let prev = 1;
      for (let f = 0; f < 40 * hz; f++) {
        const t = f / hz;
        const d = p.step(120, (t * 2) % 1, 0.8, 1 / hz);
        expect(Math.abs(d)).toBeLessThanOrEqual(1);
        expect(Math.abs(d - prev)).toBeLessThanOrEqual(REVERSE_RATE / hz + 1e-9); // no jumps
        prev = d;
        if (f % (hz / 60) === 0) trace.push(d);
      }
      return trace;
    };
    const tr = run(60);
    const beatsToFrames = 30; // 120 BPM at 60 Hz
    expect(tr[PHRASE_BEATS * beatsToFrames - 30]).toBe(1); // still forward just before the phrase ends
    expect(tr[PHRASE_BEATS * beatsToFrames + 240]).toBe(-1); // reversed a few seconds into the next
    expect(tr[2 * PHRASE_BEATS * beatsToFrames + 240]).toBe(1); // and back
    const fast = run(120);
    for (let i = 0; i < tr.length; i += 7) expect(fast[i]).toBeCloseTo(tr[i], 1);
  });
});

describe("createPhrase without a tempo", () => {
  it("holds its direction through steady music and reverses once when the energy changes for good", () => {
    const p = createPhrase();
    let d = 1;
    for (let f = 0; f < 60 * 60; f++) d = p.step(0, 0, 0.5 + 0.05 * Math.sin(f / 20), 1 / 60);
    expect(d).toBe(1);
    let flips = 0;
    let prevSign = 1;
    for (let f = 0; f < 60 * 30; f++) {
      d = p.step(0, 0, 1.2, 1 / 60); // the chorus kicks in and stays
      if (Math.sign(d) !== prevSign && d !== 0) {
        flips++;
        prevSign = Math.sign(d);
      }
    }
    expect(flips).toBe(1);
    expect(d).toBe(-1);
  });
});

/** Drift (rad/s) the drive settles to for steady input. @param {Partial<{ energy: number, surge: number, reactivity: number, speed: number, warp: number }>} over */
function settledDrift(over) {
  const d = createStripeDrive();
  const input = { density: 1, speed: 1, warp: 1, reactivity: 1, bassAtt: 1, energy: 0, surge: 0, dir: 1, ...over };
  for (let f = 0; f < 60 * 30; f++) d.step(1 / 60, input, true);
  const before = d.phase;
  for (let f = 0; f < 60; f++) d.step(1 / 60, input, true);
  return d.phase - before;
}

describe("createStripeDrive energy", () => {
  it("grows slowly and steadily in silence, several times faster in loud music, faster still on a beat surge", () => {
    const silence = settledDrift({ energy: 0 });
    const quiet = settledDrift({ energy: 0.3 });
    const loud = settledDrift({ energy: 1 });
    const surge = settledDrift({ energy: 1, surge: 1 });
    expect(silence).toBeGreaterThan(0.2); // never frozen
    expect(quiet).toBeGreaterThan(1.5 * silence);
    expect(loud).toBeGreaterThan(6 * silence);
    expect(surge).toBeGreaterThan(1.2 * loud);
    expect(surge).toBeLessThanOrEqual(DRIVE_BUDGET + 1e-9);
  });
});

describe("createStripeDrive whirlpool", () => {
  it("tightens with energy, relaxes when quiet, turns with the phrase direction, bounded and smooth", () => {
    const d = createStripeDrive();
    const input = { density: 1, speed: 1, warp: 1, reactivity: 1, bassAtt: 1, energy: 0, surge: 0, dir: 1 };
    /** @param {number} seconds */
    const run = (seconds) => {
      let prev = d.twist;
      for (let f = 0; f < 60 * seconds; f++) {
        d.step(1 / 60, input, true);
        expect(Math.abs(d.twist)).toBeLessThanOrEqual(TWIST_MAX * input.warp + 1e-9);
        expect(Math.abs(d.twist - prev)).toBeLessThan(0.02); // no jumps
        prev = d.twist;
      }
      return d.twist;
    };
    const calm = run(20);
    input.energy = 1;
    const loud = run(20);
    expect(calm).toBeGreaterThan(0.2);
    expect(loud).toBeGreaterThan(2.5 * calm);
    input.dir = -1;
    expect(run(16)).toBeCloseTo(-loud, 2); // reversed within a phrase (32 beats at 120 BPM)
    input.energy = 0;
    expect(run(20)).toBeCloseTo(-calm, 2);
  });
});

describe("createStripeDrive reactivity", () => {
  it("at Reactivity 0 ignores the music (idle growth only); higher Reactivity reacts more", () => {
    expect(settledDrift({ energy: 1, surge: 1, reactivity: 0 })).toBeCloseTo(settledDrift({ energy: 0 }), 6);
    expect(settledDrift({ energy: 0.5, reactivity: 2 })).toBeGreaterThan(1.3 * settledDrift({ energy: 0.5, reactivity: 1 }));
    expect(settledDrift({ energy: 0.5, reactivity: 0.5 })).toBeLessThan(0.8 * settledDrift({ energy: 0.5, reactivity: 1 }));
  });
});
