// @ts-check
import { describe, expect, it } from "vitest";
import {
  DISC,
  FLARES,
  SECTORS,
  TINTS,
  createCorona,
  createFlares,
  createGlare,
  createRing,
  createRipple,
  DEFAULT_REACTIVITY,
  DEFAULT_ROTATION,
  effectiveMotion,
  fitEclipse,
  skyAlpha,
  tintGamma,
} from "./eclipse.js";

const DT = 1 / 60;
const SR = 48000;

/** Angle (rad, 0 = bottom, +π/2 = right) of sector i. @param {number} i */
const angleOf = (i) => ((i + 0.5) / SECTORS - 0.5) * 2 * Math.PI;

describe("createCorona", () => {
  it("a single loud bin lights the sectors at its log-frequency angle, mirrored left/right", () => {
    const corona = createCorona();
    const spec = new Float32Array(1024);
    spec[43] = 0.5; // 43 · 48000 / 2048 ≈ 1008 Hz
    for (let t = 0; t < 0.5; t += DT) corona.step(spec, SR, DT);
    const lv = corona.levels;
    let best = 0;
    for (let i = 0; i < SECTORS; i++) if (lv[i] > lv[best]) best = i;
    expect(lv[best]).toBeGreaterThan(0.9);
    expect(lv[SECTORS - 1 - best]).toBeCloseTo(lv[best], 5);
    const expected = (Math.log(1008 / 30) / Math.log(16000 / 30)) * Math.PI; // from the bottom
    expect(Math.abs(Math.abs(angleOf(best)) - expected)).toBeLessThan((2 * Math.PI) / SECTORS);
    // Far away from that angle (e.g. the bass at the bottom, the highs at the top) stays dark.
    expect(lv[SECTORS / 2]).toBe(0);
    expect(lv[0]).toBe(0);
  });

  it("levels grow with a fast-ish attack and recede with a slower release, bounded 0–1", () => {
    const corona = createCorona();
    const spec = new Float32Array(1024);
    const quiet = new Float32Array(1024);
    spec[43] = 0.5;
    const lv = corona.levels;
    let best = 0;
    corona.step(spec, SR, DT);
    for (let i = 0; i < SECTORS; i++) if (lv[i] > lv[best]) best = i;
    expect(lv[best]).toBeGreaterThan(0.1); // moving at once…
    expect(lv[best]).toBeLessThan(0.5); // …but not a jump
    for (let t = DT; t < 0.15; t += DT) corona.step(spec, SR, DT);
    expect(lv[best]).toBeGreaterThan(0.8); // attack ≈ 50 ms
    for (let t = 0; t < 0.15; t += DT) corona.step(quiet, SR, DT);
    expect(lv[best]).toBeGreaterThan(0.35); // release is slower than attack
    for (let t = 0.15; t < 1.5; t += DT) {
      corona.step(quiet, SR, DT);
      for (let i = 0; i < SECTORS; i++) expect(lv[i] >= 0 && lv[i] <= 1).toBe(true);
    }
    expect(lv[best]).toBeLessThan(0.05);
    // A huge dt (tab restored) can't overshoot.
    corona.step(spec, SR, 10);
    expect(lv[best]).toBeLessThanOrEqual(1);
  });
});

describe("createRing", () => {
  /** Settle the ring on a constant bass level. @param {number} bass */
  const settle = (bass, react = 1, thick = 1) => {
    const ring = createRing();
    for (let t = 0; t < 3; t += DT) ring.step(bass, DT, react, thick);
    return ring;
  };

  it("at rest: the black disc at DISC inside a white annulus; Ring thickness scales the annulus", () => {
    const r = settle(0);
    expect(r.disc).toBeCloseTo(DISC, 5);
    expect(r.outer).toBeGreaterThan(r.disc + 0.05);
    expect(r.swell).toBe(0);
    const thick = settle(0, 1, 2);
    expect(thick.outer - thick.disc).toBeCloseTo(2 * (r.outer - r.disc), 5);
  });

  it("bass swells the ring (thicker, brighter) and shrinks the disc a little, monotonic and bounded", () => {
    let prev = settle(0);
    for (const bass of [0.8, 1.2, 1.6, 2, 5, 1e9]) {
      const r = settle(bass);
      expect(r.disc).toBeLessThanOrEqual(prev.disc);
      expect(r.outer - r.disc).toBeGreaterThanOrEqual(prev.outer - prev.disc);
      expect(r.swell).toBeGreaterThanOrEqual(prev.swell);
      expect(r.disc).toBeGreaterThan(0.9 * DISC); // "slightly"
      expect(r.swell).toBeLessThanOrEqual(1);
      prev = r;
    }
    expect(prev.swell).toBeCloseTo(1, 6);
    for (const bad of [NaN, -3, -Infinity]) expect(settle(bad).disc).toBeCloseTo(DISC, 5);
    expect(settle(2, 0).swell).toBeCloseTo(0, 9); // Reactivity 0: a still eclipse
  });

  it("is smooth: a bass step moves it gradually, never in one jump", () => {
    const ring = createRing();
    ring.step(0, DT, 1, 1);
    let { disc, outer, swell } = ring;
    for (let t = 0; t < 1; t += DT) {
      ring.step(t < 0.5 ? 2 : 0, DT, 1, 1);
      expect(Math.abs(ring.disc - disc)).toBeLessThan(0.004);
      expect(Math.abs(ring.outer - outer)).toBeLessThan(0.004);
      expect(Math.abs(ring.swell - swell)).toBeLessThan(0.15);
      ({ disc, outer, swell } = ring);
    }
  });
});

describe("createFlares", () => {
  /** Live flares as [radius, amp] pairs. @param {ReturnType<typeof createFlares>} f */
  const live = (f) => {
    const out = [];
    for (let i = 0; i < FLARES; i++) if (f.data[2 * i + 1] > 0) out.push([f.data[2 * i], f.data[2 * i + 1]]);
    return out;
  };

  it("spawns a flare on an onset, which travels outward and fades away", () => {
    const f = createFlares();
    for (let t = 0; t < 0.5; t += DT) f.step(false, 0, DT, 1);
    expect(live(f)).toEqual([]);
    f.step(true, 0.8, DT, 1);
    let [[r, a]] = live(f);
    expect(a).toBeGreaterThan(0.5);
    for (let t = 0; t < 0.6; t += DT) {
      f.step(false, 0, DT, 1);
      const [[r2, a2]] = live(f);
      expect(r2).toBeGreaterThan(r);
      expect(a2).toBeLessThan(a);
      [r, a] = [r2, a2];
    }
    for (let t = 0; t < 4; t += DT) f.step(false, 0, DT, 1);
    expect(live(f)).toEqual([]);
  });

  it("stronger onsets flare brighter; Reactivity 0 flares nothing", () => {
    const weak = createFlares();
    const strong = createFlares();
    weak.step(true, 0.1, DT, 1);
    strong.step(true, 1, DT, 1);
    expect(live(strong)[0][1]).toBeGreaterThan(live(weak)[0][1]);
    expect(live(strong)[0][1]).toBeLessThanOrEqual(1);
    const off = createFlares();
    off.step(true, 1, DT, 0);
    expect(live(off)).toEqual([]);
  });

  it("never holds more than FLARES: a new onset replaces the oldest", () => {
    const f = createFlares();
    for (let i = 0; i < 3 * FLARES; i++) {
      f.step(true, 1, DT, 1);
      f.step(false, 0, DT, 1);
      expect(live(f).length).toBeLessThanOrEqual(FLARES);
    }
    expect(live(f).length).toBe(FLARES);
    const newest = Math.min(...live(f).map(([r]) => r));
    f.step(true, 1, DT, 1);
    const radii = live(f).map(([r]) => r);
    expect(Math.min(...radii)).toBeLessThan(newest); // a fresh flare at the ring…
    expect(radii.length).toBe(FLARES); // …in the oldest's slot
  });
});

describe("createGlare", () => {
  /** Flashes (rises ≥ 0.05 after a fall) per second of the glare under a 10 Hz strobe. @param {boolean} limit */
  const strobe = (limit) => {
    const flares = createFlares();
    const glare = createGlare();
    let rises = 0;
    let lo = 0;
    let rising = false;
    let prev = 0;
    const frames = 4 * 60;
    for (let i = 0; i < frames; i++) {
      flares.step(i % 6 === 0, 1, DT, 1);
      const swell = i % 6 < 3 ? 1 : 0; // the bass strobes too
      glare.step(swell, flares.data, DT, limit);
      const v = glare.level;
      expect(glare.scale).toBeGreaterThanOrEqual(0);
      expect(glare.scale).toBeLessThanOrEqual(1);
      if (!rising && v - lo >= 0.05) {
        rises++;
        rising = true;
      } else if (rising && v < prev) {
        rising = false;
        lo = v;
      } else if (!rising) lo = Math.min(lo, v);
      prev = v;
    }
    return rises / (frames / 60);
  };

  it("limits full-frame brightness rises (ring swell + flares) to ≤ 3/s when Reduce flashing is on", () => {
    expect(strobe(false)).toBeGreaterThan(6);
    expect(strobe(true)).toBeLessThanOrEqual(3);
  });

  it("passes slow swells and a lone flare straight through", () => {
    const flares = createFlares();
    const glare = createGlare();
    flares.step(true, 1, DT, 1);
    glare.step(0.5, flares.data, DT, true);
    expect(glare.scale).toBe(1);
    expect(glare.level).toBeGreaterThan(0.5);
  });
});

describe("tint and sky", () => {
  it("each tint is a per-channel gamma on the grey value: black stays black, white stays white", () => {
    expect(TINTS).toEqual(["monochrome", "silver", "sepia", "cold blue"]);
    const g = new Float32Array(3);
    expect([...tintGamma("monochrome", g)]).toEqual([1, 1, 1]);
    const seen = new Set();
    for (const name of TINTS) {
      tintGamma(name, g);
      for (const c of g) expect(c).toBeGreaterThan(0.5);
      seen.add(g.join());
    }
    expect(seen.size).toBe(TINTS.length);
    tintGamma("sepia", g);
    expect(0.5 ** g[0]).toBeGreaterThan(0.5 ** g[2]); // warm mid-greys: more red than blue
    tintGamma("cold blue", g);
    expect(0.5 ** g[2]).toBeGreaterThan(0.5 ** g[0]);
    expect([...tintGamma("nonsense", g)]).toEqual([1, 1, 1]);
  });

  it("sky black is opaque; none makes black transparent; unknown → black", () => {
    expect(skyAlpha("black")).toBe(1);
    expect(skyAlpha("none")).toBe(0);
    expect(skyAlpha(undefined)).toBe(1);
  });
});

describe("fitEclipse", () => {
  it("centres the composition and fits its unit radius inside min(width, height) with a margin", () => {
    const out = { cx: 0, cy: 0, radius: 0 };
    for (const [w, h] of [
      [2560, 1440],
      [1440, 2560],
      [1000, 1000],
      [3440, 1440],
      [800, 3000],
    ]) {
      fitEclipse(w, h, out);
      expect([out.cx, out.cy]).toEqual([w / 2, h / 2]);
      const m = Math.min(w, h);
      expect(out.radius).toBeLessThan(m / 2 - 0.02 * m);
      expect(out.radius).toBeGreaterThan(0.4 * m);
    }
    fitEclipse(0, 0, out);
    expect(out.radius).toBeGreaterThan(0); // never divides by zero
  });
});

describe("effectiveMotion", () => {
  it("passes the params through normally", () => {
    const m = { rotation: 0, reactivity: 0, drift: 0 };
    effectiveMotion(0.2, 1.5, false, m);
    expect(m).toEqual({ rotation: 0.2, reactivity: 1.5, drift: 1 });
  });

  it("Reduce motion: calmer defaults (slower rotation and drift, gentler reactivity), user picks respected", () => {
    const m = { rotation: 0, reactivity: 0, drift: 0 };
    effectiveMotion(DEFAULT_ROTATION, DEFAULT_REACTIVITY, true, m);
    expect(Math.abs(m.rotation)).toBeLessThan(0.5 * DEFAULT_ROTATION);
    expect(m.reactivity).toBeLessThan(DEFAULT_REACTIVITY);
    expect(m.reactivity).toBeGreaterThan(0);
    expect(m.drift).toBeLessThan(1);
    effectiveMotion(0.2, 1.5, true, m);
    expect([m.rotation, m.reactivity]).toEqual([0.2, 1.5]);
    expect(m.drift).toBeLessThan(1);
  });
});

describe("createRipple", () => {
  it("wraps the waveform around the ring, mirrored left/right, smooth in angle and time, any length", () => {
    for (const len of [2048, 1024, 0]) {
      const ripple = createRipple();
      const wave = new Float32Array(len);
      for (let i = 0; i < len; i++) wave[i] = Math.sin((i / len) * 2 * Math.PI * 3);
      ripple.step(wave, DT);
      const first = ripple.out.slice();
      for (let t = 0; t < 0.5; t += DT) ripple.step(wave, DT);
      const r = ripple.out;
      for (let i = 0; i < SECTORS; i++) {
        expect(r[i]).toBeCloseTo(r[SECTORS - 1 - i], 5);
        expect(Math.abs(r[i])).toBeLessThanOrEqual(1);
        expect(Math.abs(r[i] - first[i])).toBeLessThanOrEqual(Math.abs(r[i]) * 0.9 + 1e-6); // eased in
        if (i > 0) expect(Math.abs(r[i] - r[i - 1])).toBeLessThan(0.15); // no jaggies
      }
      const peak = Math.max(...r);
      if (len) expect(peak).toBeGreaterThan(0.5);
      else expect(peak).toBe(0);
    }
  });
});
