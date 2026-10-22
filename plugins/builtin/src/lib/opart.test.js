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
  DUTY_RESERVE,
  MAX_ALT_HZ,
  RATE_BUDGET,
  createEnergy,
  createBulge,
  createEmitters,
  emitterSpot,
  outlineField,
  opartDefines,
  RIPPLE_WIDTH,
  TWIST_FALLOFF,
  EMIT_K,
  EMIT_RESERVE,
  EMIT_IDLE,
  BULGE_PHASE,
  BULGE_RESERVE,
  BULGE_SLEW,
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
  RIPPLE_BIRTH,
  RIPPLE_PHASE,
  RIPPLE_RESERVE,
  RIPPLE_SUM,
  RIPPLE_VISIBLE,
  ripplePhase,
  TWIST_MAX,
  TWIST_SENS,
  stripe,
  WAVE_PHASE,
  WAVE_RESERVE,
  WAVE_SLEW,
} from "./opart.js";
import { CAM_DIST, screenRadius } from "./skull-bounds.js";
import { PULSE_LIMIT, REDUCED, TILT_LIMIT } from "./skull-motion.js";

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
  const input = { density: 2, speed: 2, warp: 2, reactivity: 2, bassAtt: 1, energy: 1, surge: 0, dir: 1, local: 0, ...knobs };
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
  it("with reduceFlashing, keeps every pixel's phase rate within what the local effects leave of RATE_BUDGET, at any density, speed and warp", () => {
    for (const density of [0.5, 1, 2])
      for (const speed of [0, 1, 2])
        for (const warp of [0, 1, 2])
          for (const hz of [60, 120]) {
            const d = createStripeDrive();
            const v = violentInput({ density, speed, warp });
            let seed = 3;
            const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
            for (let f = 0; f < hz * 4; f++) {
              v.next();
              const local = rnd() * (RATE_BUDGET - DRIVE_BUDGET); // what the local effects used
              const prev = { phase: d.phase, freq: d.freq, flow: d.flow, twist: d.twist };
              d.step(1 / hz, { ...v.input, local }, true);
              const dk = Math.abs(d.freq - prev.freq);
              const worst = dk * FIELD_MAX + (d.phase - prev.phase) + (prev.freq + dk) * (FLOW_SENS * warp * Math.abs(d.flow - prev.flow) + TWIST_SENS * Math.abs(d.twist - prev.twist));
              expect(worst * hz + local, `${density} ${speed} ${warp} ${hz} Hz`).toBeLessThanOrEqual(RATE_BUDGET * (1 + 1e-9));
            }
          }
  });

  it("gives a beat surge the budget the local effects leave unused", () => {
    const drift = (/** @type {number} */ local) => {
      const d = createStripeDrive();
      const input = { density: 1, speed: 1, warp: 1, reactivity: 1, bassAtt: 1, energy: 1, surge: 1, dir: 1, local };
      for (let f = 0; f < 600; f++) d.step(1 / 60, input, true);
      const before = d.phase;
      d.step(1 / 60, input, true);
      return (d.phase - before) * 60;
    };
    expect(drift(0)).toBeGreaterThan(1.5 * drift(RATE_BUDGET - DRIVE_BUDGET));
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
    for (let f = 0; f < 60 * 6; f++) {
      r.step(1 / 60);
      seen.push([r.data[0], r.data[1]]);
    }
    expect(seen[0][0]).toBeGreaterThan(RIPPLE_BIRTH);
    expect(seen[119][0] - seen[59][0]).toBeCloseTo(RIPPLE_SPEED * 1, 4); // once out from under the skull
    expect(seen[0][1]).toBeGreaterThan(0.9);
    for (let i = 1; i < seen.length; i++) expect(seen[i][1]).toBeLessThanOrEqual(seen[i - 1][1]);
    expect(seen[seen.length - 1][1]).toBe(0);
  });

  it("keeps at most `cap` rings and never cuts a live one off: with no free slot or strength left, a beat launches none", () => {
    const r = createRipples(4);
    for (let i = 0; i < 6; i++) {
      r.spawn(0.2);
      r.step(0.1);
    }
    const radii = [];
    for (let i = 0; i < 4; i++) radii.push(r.data[2 * i]);
    radii.sort((a, b) => a - b);
    expect(r.data.length).toBe(8);
    expect(radii[3] - radii[0]).toBeCloseTo(RIPPLE_SPEED * 0.3, 4); // the 5th and 6th were skipped
    expect(radii[0]).toBeGreaterThan(RIPPLE_BIRTH + RIPPLE_SPEED * 0.3);
    const big = createRipples(8);
    big.spawn(1);
    big.spawn(1);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += big.data[2 * i + 1];
    expect(sum).toBeLessThanOrEqual(RIPPLE_SUM + 1e-6);
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
    expect(loud).toBeGreaterThan(4 * silence);
    expect(surge).toBeGreaterThan(2.5 * loud); // the beats carry most of the motion
    const weak = settledDrift({ energy: 1, surge: 0.4 });
    expect(weak - loud).toBeLessThan(0.35 * (surge - loud)); // weak onsets only nudge
    expect(surge).toBeLessThanOrEqual(RATE_BUDGET + 1e-9);
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

describe("createThickness edge speed", () => {
  it("moves the stripe edges no faster than DUTY_RESERVE (rad/s of phase), yet still swells on a bass hit", () => {
    for (const hz of [60, 120]) {
      const t = createThickness();
      let prev = Math.asin(0);
      let most = 0;
      for (let f = 0; f < hz * 4; f++) {
        const bass = f % Math.round(hz / 10) === 0 ? 3 : 0.2; // 10 Hz bass strobe
        const edge = Math.asin(t.step(bass, 2, 1 / hz, true));
        expect(Math.abs(edge - prev) * hz).toBeLessThanOrEqual(DUTY_RESERVE + 1e-9);
        most = Math.max(most, edge);
        prev = edge;
      }
      expect(Math.sin(most)).toBeGreaterThan(0.3 * DUTY_MAX);
    }
  });
});

describe("createRipples anti-strobe", () => {
  it("under any barrage of beats, no point's ripple phase changes faster than RIPPLE_RESERVE; rings cross the screen", () => {
    for (const hz of [60, 120]) {
      const r = createRipples(8);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const ds = Array.from({ length: 200 }, (_, i) => (i / 199) * 2.4); // the skull's edge to a 21:9 corner
      let prev = ds.map((d) => ripplePhase(d, r.data));
      for (let f = 0; f < hz * 6; f++) {
        if (rnd() < 0.3) r.spawn(rnd() < 0.5 ? 1 : rnd());
        r.step(1 / hz);
        const now = ds.map((d) => ripplePhase(d, r.data));
        for (let i = 0; i < ds.length; i++) expect(Math.abs(now[i] - prev[i]) * hz).toBeLessThanOrEqual(RIPPLE_RESERVE + 1e-6);
        prev = now;
      }
    }
    const one = createRipples(8);
    one.spawn(1);
    let t = 0;
    while (one.data[0] < 1.8) {
      one.step(1 / 60);
      t += 1 / 60;
    }
    expect(one.data[1]).toBeGreaterThan(0.15); // still a clear ring at the screen's edge
    expect(RIPPLE_PHASE * one.data[1]).toBeGreaterThan(0.3);
  });
});

describe("createRippleTrigger strength", () => {
  it("sizes each ripple by its onset's strength: a full-strength beat launches a full ripple, a weak one a faint ring", () => {
    const full = createRippleTrigger().step(true, 1, 1, 1 / 60, true);
    const weak = createRippleTrigger().step(true, 0.3, 1, 1 / 60, true);
    expect(full).toBeCloseTo(1, 5);
    expect(weak).toBeCloseTo(0.3, 5);
  });
});

describe("createBulge (spectrum round the skull)", () => {
  it("bulges the stripes at the angle of the loud band: bass under the jaw, highs over the cranium; silent → none", () => {
    /** @param {(i: number) => number} shape band level by index (0 = 30 Hz … 63 = 16 kHz) */
    const settle = (shape) => {
      const b = createBulge(16);
      const bands = new Float32Array(64).map((_, i) => shape(i));
      let out = b.step(bands, 1, 1 / 60);
      for (let f = 0; f < 600; f++) out = b.step(bands, 1, 1 / 60);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      return Array.from(out);
    };
    expect(Math.max(...settle(() => 0))).toBe(0);
    const bass = settle((i) => (i < 4 ? 0.9 : 0.05));
    expect(bass.indexOf(Math.max(...bass))).toBe(15); // sector 15 is straight down (the jaw)
    expect(bass[0]).toBe(0);
    const highs = settle((i) => (i >= 60 ? 0.9 : 0.05));
    expect(highs.indexOf(Math.max(...highs))).toBe(0); // sector 0 is straight up (the cranium)
    expect(highs[15]).toBe(0);
  });

  it("slews within the reserved phase budget and scales with Reactivity", () => {
    expect(BULGE_PHASE * BULGE_SLEW).toBeLessThanOrEqual(BULGE_RESERVE + 1e-12);
    for (const hz of [60, 120]) {
      const b = createBulge(16);
      const loud = new Float32Array(64).fill(1);
      const none = new Float32Array(64);
      let prev = Array.from(b.step(none, 2, 1 / hz));
      for (let f = 0; f < hz * 6; f++) {
        const now = Array.from(b.step(f % 30 < 15 ? loud : none, 2, 1 / hz));
        for (let i = 0; i < 16; i++) expect(Math.abs(now[i] - prev[i]) * hz).toBeLessThanOrEqual(BULGE_SLEW + 1e-6);
        prev = now;
      }
    }
    /** @param {number} react */
    const level = (react) => {
      const b = createBulge(16);
      const bands = new Float32Array(64).fill(0.5);
      let out = b.step(bands, react, 1 / 60);
      for (let f = 0; f < 600; f++) out = b.step(bands, react, 1 / 60);
      return out[8];
    };
    expect(level(0)).toBe(0);
    expect(level(2)).toBeGreaterThan(1.5 * level(1));
  });
});

describe("createEmitters", () => {
  const outline = [0.594, 0, 0.1];
  const base = { flow: 3, warp: 1, outline, twist: 0.5 };

  it("each emitter changes the field no faster than EMIT_RESERVE of phase a second, at any density", () => {
    for (const freq of [16, 32, 70]) {
      const em = createEmitters(6);
      let seed = 9;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const pts = Array.from({ length: 300 }, () => [(rnd() * 2 - 1) * 1.8, rnd() * 2 - 1]).filter(([x, y]) => Math.hypot(x, y) > 0.8);
      let prev = pts.map(([x, y]) => opField(x, y, { ...base, emitters: em.data }));
      for (let f = 0; f < 60 * 16; f++) {
        if (f % 40 === 0) em.spawn(Math.cos(f) * 1.2, Math.sin(f) * 0.9, outline);
        em.step(1 / 60, freq, outline, true);
        const now = pts.map(([x, y]) => opField(x, y, { ...base, emitters: em.data }));
        for (let i = 0; i < pts.length; i++) expect(Math.abs(now[i] - prev[i]) * freq * 60).toBeLessThanOrEqual(EMIT_RESERVE * 1.001);
        prev = now;
      }
    }
  });
});

describe("createEmitters lifecycle", () => {
  const outline = [0.594, 0, 0.1];
  const st = { flow: 0, warp: 0, outline, twist: 0 };
  /** Whether the field has a dimple at (x, y): a local minimum, where closed loops are born. */
  const dimple = (/** @type {Float32Array} */ data, /** @type {number} */ x, /** @type {number} */ y) => {
    const c = opField(x, y, { ...st, emitters: data });
    for (let a = 0; a < 8; a++) {
      const f = opField(x + 0.04 * Math.cos(a), y + 0.04 * Math.sin(a), { ...st, emitters: data });
      if (f <= c) return false;
    }
    return true;
  };

  it("appears from nothing, soon pours out closed loops, then winds down and frees its slot", () => {
    const em = createEmitters(2);
    const before = opField(1.3, 0.2, st);
    expect(em.spawn(1.3, 0.2, outline)).toBe(true);
    expect(opField(1.3, 0.2, { ...st, emitters: em.data })).toBeCloseTo(before, 6); // no pop
    let t = 0;
    while (!dimple(em.data, 1.3, 0.2) && t < 5) {
      em.step(1 / 60, BASE_K, outline, true);
      t += 1 / 60;
    }
    expect(t).toBeLessThan(1.5);
    for (let f = 0; f < 60 * 20; f++) em.step(1 / 60, BASE_K, outline, true);
    expect(em.count).toBe(0);
    expect(em.data[2]).toBe(EMIT_IDLE);
  });

  it("keeps at most `cap` emitters and none on top of the skull", () => {
    const em = createEmitters(2);
    expect(em.spawn(0, 0, outline)).toBe(false);
    expect(em.spawn(1.3, 0, outline)).toBe(true);
    expect(em.spawn(-1.3, 0, outline)).toBe(true);
    expect(em.spawn(0, 1.5, outline)).toBe(false);
    expect(em.count).toBe(2);
  });
});

describe("emitterSpot", () => {
  it("places an emitter at its sector's angle round the skull (highs above, bass below), on the given side, clear of the skull", () => {
    const outline = [0.594, 0.05, 0.1];
    const out = new Float32Array(2);
    for (let seq = 0; seq < 20; seq++) {
      for (const side of [-1, 1]) {
        emitterSpot(0, 16, side, seq, outline, out);
        expect(out[1]).toBeGreaterThan(0);
        expect(Math.abs(out[0])).toBeLessThan(out[1]);
        emitterSpot(15, 16, side, seq, outline, out);
        expect(out[1]).toBeLessThan(0);
        emitterSpot(8, 16, side, seq, outline, out);
        expect(Math.sign(out[0])).toBe(side);
        const line = outlineField(out[0], out[1], outline);
        expect(line).toBeGreaterThanOrEqual(0.25);
        expect(line).toBeLessThanOrEqual(0.75);
      }
    }
  });
});

describe("per-pixel alternation budget", () => {
  it("drive + every local effect's reserve fit RATE_BUDGET: no pixel alternates faster than MAX_ALT_HZ with reduceFlashing", () => {
    const sum = DRIVE_BUDGET + WAVE_RESERVE + RIPPLE_RESERVE + BULGE_RESERVE + EMIT_RESERVE + DUTY_RESERVE;
    expect(sum).toBeLessThanOrEqual(RATE_BUDGET + 1e-9);
    expect(RATE_BUDGET / (2 * Math.PI)).toBeLessThanOrEqual(MAX_ALT_HZ);
    expect(DRIVE_BUDGET).toBeGreaterThan(0.3 * RATE_BUDGET); // the drift keeps a real share
  });
});

describe("createStripeDrive under Reduce motion", () => {
  it("Reduce motion's calmer speed and warp grow the loops and twist the whirlpool more gently", () => {
    const calm = { speed: REDUCED.speed, warp: REDUCED.warp };
    expect(settledDrift({ energy: 1, ...calm })).toBeLessThan(0.5 * settledDrift({ energy: 1 }));
    expect(settledDrift({ energy: 0, ...calm })).toBeGreaterThan(0); // still growing
    const twist = (/** @type {{ speed?: number, warp?: number }} */ k) => {
      const d = createStripeDrive();
      const input = { density: 1, speed: 1, warp: 1, reactivity: 1, bassAtt: 1, energy: 1, surge: 0, dir: 1, ...k };
      for (let f = 0; f < 60 * 30; f++) d.step(1 / 60, input, true);
      return d.twist;
    };
    expect(twist(calm)).toBeLessThan(0.7 * twist({}));
  });
});

describe("opartDefines", () => {
  it("hands the shader the same constants the bounds were checked with (floats as GLSL floats)", () => {
    const src = opartDefines({ ripples: 8, wave: 32, emitters: 6, sectors: 16 });
    /** @param {string} name */
    const get = (name) => {
      const m = src.match(new RegExp(`^#define ${name} (\\S+)$`, "m"));
      expect(m, name).not.toBeNull();
      return /** @type {RegExpMatchArray} */ (m)[1];
    };
    expect(get("RIPPLES")).toBe("8");
    expect(get("EMITTERS")).toBe("6");
    expect(get("WAVE_POINTS")).toBe("32");
    expect(get("BULGE_SECTORS")).toBe("16");
    for (const [name, v] of Object.entries({ WAVE_PHASE, RIPPLE_PHASE, RIPPLE_WIDTH, BULGE_PHASE, EMIT_K, TWIST_FALLOFF })) {
      expect(get(name)).toMatch(/^-?\d+\.\d+(e-?\d+)?$/);
      expect(Number(get(name))).toBeCloseTo(v, 9);
    }
  });
});

describe("local effects report the phase rate they use", () => {
  it("ripples: `rate` bounds every visible point's ripple phase rate, stays within RIPPLE_RESERVE, and is 0 when idle", () => {
    for (const hz of [60, 120]) {
      const r = createRipples(8);
      r.step(1 / hz);
      expect(r.rate).toBe(0);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const ds = Array.from({ length: 240 }, (_, i) => RIPPLE_VISIBLE + (i / 239) * (2.4 - RIPPLE_VISIBLE));
      let prev = ds.map((d) => ripplePhase(d, r.data));
      let early = Infinity;
      for (let f = 0; f < hz * 6; f++) {
        if (rnd() < 0.05) r.spawn(rnd() < 0.5 ? 1 : rnd());
        r.step(1 / hz);
        expect(r.rate).toBeLessThanOrEqual(RIPPLE_RESERVE + 1e-6);
        const now = ds.map((d) => ripplePhase(d, r.data));
        for (let i = 0; i < ds.length; i++) expect(Math.abs(now[i] - prev[i]) * hz).toBeLessThanOrEqual(r.rate * 1.02 + 0.05); // + a birth: ≤ RIPPLE_PHASE·e⁻⁹ rad
        prev = now;
      }
      const one = createRipples(8);
      one.spawn(1);
      one.step(1 / hz);
      early = one.rate;
      expect(early).toBeLessThan(0.25 * RIPPLE_RESERVE); // a newborn ring is still under the skull
    }
  });
});

describe("bulge, wave bend, thickness and emitters report their phase rate", () => {
  it("bulge: `rate` is BULGE_PHASE × its fastest sector's change, within BULGE_RESERVE", () => {
    const b = createBulge(16);
    const loud = new Float32Array(64).fill(1);
    let prev = Array.from(b.step(new Float32Array(64), 1, 1 / 60));
    expect(b.rate).toBe(0);
    for (let f = 0; f < 120; f++) {
      const now = Array.from(b.step(f < 60 ? loud : new Float32Array(64), 1, 1 / 60));
      const most = Math.max(...now.map((v, i) => Math.abs(v - prev[i])));
      expect(b.rate).toBeCloseTo(BULGE_PHASE * most * 60, 4);
      expect(b.rate).toBeLessThanOrEqual(BULGE_RESERVE + 1e-6);
      prev = now;
    }
  });
});

describe("wave bend and thickness report their phase rate", () => {
  it("wave bend: `rate` is WAVE_PHASE × its fastest point's change, within WAVE_RESERVE", () => {
    const b = createWaveBend(32);
    const wave = new Float32Array(2048);
    let prev = Array.from(b.step(wave, 1 / 60));
    for (let f = 0; f < 120; f++) {
      for (let i = 0; i < wave.length; i++) wave[i] = Math.sin(i / 50 + f / 7) * (f < 60 ? 1 : 0.1);
      const now = Array.from(b.step(wave, 1 / 60));
      const most = Math.max(...now.map((v, i) => Math.abs(v - prev[i])));
      expect(b.rate).toBeCloseTo(WAVE_PHASE * most * 60, 4);
      expect(b.rate).toBeLessThanOrEqual(WAVE_RESERVE + 1e-6);
      prev = now;
    }
  });
});

describe("thickness and emitters report their phase rate", () => {
  it("thickness: `rate` is how fast the stripe edges (asin of the threshold) moved, within DUTY_RESERVE", () => {
    const t = createThickness();
    let prev = 0;
    for (let f = 0; f < 240; f++) {
      const v = t.step(f % 20 === 0 ? 3 : 0.2, 2, 1 / 60, true);
      expect(t.rate).toBeCloseTo(Math.abs(Math.asin(v) - Math.asin(prev)) * 60, 6);
      expect(t.rate).toBeLessThanOrEqual(DUTY_RESERVE + 1e-9);
      prev = v;
    }
  });

  it("emitters: `rate` (freq × the fastest offset's change) bounds the field's phase change, within EMIT_RESERVE", () => {
    const outline = [0.594, 0, 0];
    const st = { flow: 1, warp: 1, outline, twist: 0.4 };
    const em = createEmitters(6);
    const pts = Array.from({ length: 200 }, (_, i) => [Math.cos(i) * (0.9 + (i % 9) * 0.15), Math.sin(i * 1.3) * (0.9 + (i % 7) * 0.12)]);
    let prev = pts.map(([x, y]) => opField(x, y, { ...st, emitters: em.data }));
    let seen = 0;
    for (let f = 0; f < 60 * 14; f++) {
      if (f % 50 === 0) em.spawn(Math.cos(f) * 1.3, Math.sin(f) * 0.9, outline);
      em.step(1 / 60, BASE_K, outline, true);
      expect(em.rate).toBeLessThanOrEqual(EMIT_RESERVE * 1.001);
      const now = pts.map(([x, y]) => opField(x, y, { ...st, emitters: em.data }));
      for (let i = 0; i < pts.length; i++) expect(Math.abs(now[i] - prev[i]) * BASE_K * 60).toBeLessThanOrEqual(em.rate * 1.001 + 1e-6);
      seen = Math.max(seen, em.rate);
      prev = now;
    }
    expect(seen).toBeGreaterThan(0.5 * EMIT_RESERVE);
    for (let f = 0; f < 60 * 30; f++) em.step(1 / 60, BASE_K, outline, true);
    expect(em.rate).toBe(0);
  });
});

describe("local effects pause for the beat", () => {
  it("a pace below 1 slows the wave bend, bulge, ripples and emitters (and their rates) so a beat surge gets the budget", () => {
    const wave = new Float32Array(2048).fill(1);
    const loud = new Float32Array(64).fill(1);
    const outline = [0.594, 0, 0];
    /** @param {number} pace */
    const run = (pace) => {
      const b = createWaveBend(32);
      const g = createBulge(16);
      const r = createRipples(8);
      const e = createEmitters(6);
      r.spawn(1);
      e.spawn(1.3, 0, outline);
      for (let f = 0; f < 30; f++) {
        b.step(wave, 1 / 60, pace);
        g.step(loud, 1, 1 / 60, pace);
        r.step(1 / 60, pace);
        e.step(1 / 60, BASE_K, outline, true, pace);
      }
      return { bend: b.rate, bulge: g.rate, ripple: r.rate, emit: e.rate, radius: r.data[1] > 0 ? r.data[0] : NaN };
    };
    const full = run(1);
    const slow = run(0.25);
    for (const k of /** @type {const} */ (["bend", "bulge", "emit"])) expect(slow[k], k).toBeCloseTo(0.25 * full[k], 6);
    expect(slow.ripple).toBeLessThan(0.5 * full.ripple);
    expect(slow.radius).toBeLessThan(full.radius);
  });
});
