// @ts-check
import { describe, expect, it } from "vitest";
import { DISC, SECTORS, createCorona, createRing } from "./eclipse.js";

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
