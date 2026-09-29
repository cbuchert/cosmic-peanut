// @ts-check
import { describe, expect, it } from "vitest";
import { AUTO_ORDER, createIntensity, createSequencer, FADE, MATERIALS, PHRASE_BARS, thinFilm } from "./tetra-material.js";

describe("createSequencer", () => {
  it("shows the chosen material; a change of choice crossfades over FADE seconds", () => {
    const s = createSequencer();
    for (let i = 0; i < 60; i++) s.step("glass", 1 / 60, 120, 0.3);
    expect(MATERIALS[s.a]).toBe("glass");
    expect(s.mix).toBe(0);
    s.step("fire", 1 / 60, 120, 0.3);
    expect(MATERIALS[s.b]).toBe("fire");
    expect(s.mix).toBeGreaterThan(0);
    expect(s.mix).toBeLessThan(0.1);
    let prev = s.mix;
    for (let i = 0; i < Math.round(FADE * 60) - 2; i++) {
      s.step("fire", 1 / 60, 120, 0.3);
      expect(s.mix).toBeGreaterThanOrEqual(prev); // a smooth ramp
      prev = s.mix;
    }
    for (let i = 0; i < 10; i++) s.step("fire", 1 / 60, 120, 0.3);
    expect(MATERIALS[s.a]).toBe("fire");
    expect(s.mix).toBe(0);
    for (let i = 0; i < 60; i++) s.step("nonsense", 1 / 60, 120, 0.3);
    expect(MATERIALS[s.a]).toBe("chrome"); // unknown → the default
  });

  it("starts on the chosen material with no fade", () => {
    const s = createSequencer();
    s.step("velvet", 1 / 60, 0, 0);
    expect(MATERIALS[s.a]).toBe("velvet");
    expect(s.mix).toBe(0);
  });

  /** Material names shown (fade targets) over `sec` seconds of auto at a tempo and energy curve. */
  const run = (/** @type {number} */ sec, /** @type {number} */ bpm, /** @type {(t: number) => number} */ energy) => {
    const s = createSequencer();
    /** @type {{ t: number, name: string }[]} */
    const starts = [];
    let last = -1;
    for (let f = 0; f < sec * 60; f++) {
      s.step("auto", 1 / 60, bpm, energy(f / 60));
      if (s.b !== last) {
        starts.push({ t: f / 60, name: MATERIALS[s.b] });
        last = s.b;
      }
    }
    return starts;
  };

  it("auto: moves on every PHRASE_BARS bars at the tempo, through every material, deterministically", () => {
    const starts = run(200, 120, () => 0.2);
    const phrase = (PHRASE_BARS * 4 * 60) / 120;
    expect(starts[0]).toEqual({ t: 0, name: AUTO_ORDER[0] });
    for (let i = 1; i < starts.length; i++) expect(starts[i].t - starts[i - 1].t).toBeCloseTo(phrase, 1);
    expect(new Set(starts.map((x) => x.name))).toEqual(new Set(MATERIALS));
    expect(run(200, 120, () => 0.2)).toEqual(starts);
    expect(starts.map((x) => x.name).slice(0, 9)).toEqual(AUTO_ORDER);
    // Without a tempo it still moves on, on a fixed clock.
    expect(run(60, 0, () => 0.2).length).toBeGreaterThanOrEqual(2);
  });

  it("auto: a sustained change in energy moves on early; a brief spike doesn't", () => {
    const drop = run(14, 120, (t) => (t < 8 ? 0.3 : 0.03)); // the band drops out at 8 s
    expect(drop.length).toBe(2);
    expect(drop[1].t).toBeGreaterThan(8);
    expect(drop[1].t).toBeLessThan(11);
    const spike = run(14, 120, (t) => (t > 8 && t < 8.3 ? 0.9 : 0.1));
    expect(spike.length).toBe(1);
  });
});

describe("thinFilm", () => {
  it("is bounded 0..1, black as the film vanishes, and cycles through colours with thickness", () => {
    const c = new Float32Array(3);
    /** @type {number[][]} */
    const seen = [];
    for (let d = 0; d <= 1500; d += 10) {
      for (const cos of [1, 0.7, 0.3, 0.05]) {
        thinFilm(d, cos, c);
        for (const v of c) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      thinFilm(d, 1, c);
      seen.push([...c]);
    }
    thinFilm(0, 1, c);
    expect(Math.max(...c)).toBeLessThan(0.05); // the black film just before a bubble pops
    // Thickness changes the colour: 250 nm and 400 nm differ, and first-order colours are vivid.
    const a = thinFilm(250, 1, new Float32Array(3));
    const b = thinFilm(400, 1, new Float32Array(3));
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.25);
    const chroma = seen.map((x) => Math.max(...x) - Math.min(...x));
    expect(Math.max(...chroma)).toBeGreaterThan(0.4);
    // Every channel peaks somewhere in the range: a rainbow, not one tint.
    for (let ch = 0; ch < 3; ch++) expect(Math.max(...seen.map((x) => x[ch]))).toBeGreaterThan(0.6);
    // Viewing angle shifts the colour too (the film looks thinner at grazing angles).
    const g = thinFilm(400, 0.2, new Float32Array(3));
    expect(Math.hypot(g[0] - b[0], g[1] - b[1], g[2] - b[2])).toBeGreaterThan(0.1);
  });
});

describe("createIntensity", () => {
  /** Most separate rises (≥ 0.05) that start within any one second. */
  const risesPerSecond = (/** @type {number[]} */ v, /** @type {number} */ hz) => {
    /** @type {number[]} */
    const starts = [];
    let lo = v[0];
    let rising = false;
    for (let i = 1; i < v.length; i++) {
      if (v[i] > v[i - 1]) {
        if (!rising && v[i] - lo >= 0.05) {
          starts.push(i / hz);
          rising = true;
        }
      } else if (v[i] < v[i - 1]) {
        rising = false;
        lo = v[i];
      }
      if (!rising) lo = Math.min(lo, v[i]);
    }
    let best = 0;
    for (let i = 0; i < starts.length; i++) best = Math.max(best, starts.filter((t) => t >= starts[i] && t - starts[i] < 1).length);
    return best;
  };

  it("pulses with onsets and energy, bounded; a 10 Hz strobe flashes at most 3 times/s with reduceFlashing", () => {
    for (const reduce of [true, false]) {
      const g = createIntensity();
      /** @type {number[]} */
      const out = [];
      for (let f = 0; f < 60 * 4; f++) {
        const hit = f % 6 === 0; // 10 Hz
        const v = g.step(hit, hit ? 1 : 0, hit ? 0.6 : 0.05, 1 / 60, reduce);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.6);
        out.push(v);
      }
      const n = risesPerSecond(out, 60);
      if (reduce) expect(n).toBeLessThanOrEqual(3);
      else expect(n).toBeGreaterThan(3); // the limiter is what holds it back
    }
    const calm = createIntensity();
    let v = 0;
    for (let f = 0; f < 300; f++) v = calm.step(false, 0, 0.2, 1 / 60, true);
    expect(calm.step(false, 0, 0.2, 1 / 60, true)).toBeCloseTo(v, 6); // steady music, steady light
    expect(v).toBeGreaterThan(0.5);
  });
});
