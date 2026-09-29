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
  DUTY_MAX,
  FIELD_MAX,
  FLOW_SENS,
  lookColors,
  resolveLook,
  RIPPLE_SPEED,
  stripe,
  WAVE_PHASE,
  WAVE_RESERVE,
  WAVE_SLEW,
} from "./opart.js";

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

/** Violent, random drive input (max params, pumping bass and energy). */
function violentInput() {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const input = { density: 2, speed: 2, warp: 2, reactivity: 2, bass: 1, bassAtt: 1, energy: 1 };
  return {
    input,
    next() {
      input.bass = rnd() * 4;
      input.bassAtt = rnd() < 0.5 ? 0 : 3;
      input.energy = rnd() * 3;
    },
  };
}

/**
 * Most stripe inversions any pixel sees in a 1 s window. A pixel at field value F, whose field
 * moves with the flow at s·FLOW_SENS·warp per unit of flow, has phase P = freq·f − phase.
 */
/** @param {number} hz @param {number} seconds @param {boolean} reduceFlashing */
function worstInversions(hz, seconds, reduceFlashing) {
  let worst = 0;
  for (const F of [0, 0.5 * FIELD_MAX, FIELD_MAX]) {
    for (const s of [-1, 0, 1]) {
      const d2 = createStripeDrive();
      const v2 = violentInput();
      let P = 0.1; // just off an edge
      const flips = [];
      let prev = { phase: d2.phase, freq: d2.freq, flow: d2.flow };
      for (let f = 0; f < hz * seconds; f++) {
        v2.next();
        d2.step(1 / hz, v2.input, reduceFlashing);
        const dP = (d2.freq - prev.freq) * F + d2.freq * s * FLOW_SENS * v2.input.warp * (d2.flow - prev.flow) - (d2.phase - prev.phase);
        const before = Math.floor(P / Math.PI);
        P += dP;
        const after = Math.floor(P / Math.PI);
        for (let n = 0; n < Math.abs(after - before); n++) flips.push(f / hz);
        prev = { phase: d2.phase, freq: d2.freq, flow: d2.flow };
      }
      for (let i = 0; i < flips.length; i++) {
        let n = 0;
        while (i + n < flips.length && flips[i + n] - flips[i] < 1) n++;
        worst = Math.max(worst, n);
      }
    }
  }
  return worst;
}

describe("createStripeDrive anti-strobe", () => {
  it("with reduceFlashing, no pixel's stripe inverts more than 3 times a second, even at max params", () => {
    for (const hz of [60, 120]) expect(worstInversions(hz, 8, true), `${hz} Hz`).toBeLessThanOrEqual(3);
  });

  it("without reduceFlashing, max params may flow faster", () => {
    expect(worstInversions(60, 8, false)).toBeGreaterThan(3);
  });
});

describe("createStripeDrive breathing", () => {
  it("packs the stripes tighter on heavy bass and loosens them when it drops, within ±BREATHE/2", () => {
    const d = createStripeDrive();
    const input = { density: 1, speed: 1, warp: 1, reactivity: 1, bass: 1, bassAtt: 2, energy: 1 };
    for (let f = 0; f < 180; f++) d.step(1 / 60, input, true);
    const hi = d.freq;
    input.bassAtt = 0;
    for (let f = 0; f < 180; f++) d.step(1 / 60, input, true);
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
