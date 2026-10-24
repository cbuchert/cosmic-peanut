// @ts-check
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEED,
  PALETTE_FLOATS,
  PALETTES,
  REDUCED_SPEED,
  SPEED_UNIT,
  SURGE,
  QUALITIES,
  REDUCED_MOTION,
  motionScale,
  REDUCED_AXIS,
  createAxisLight,
  THICKNESS,
  flySpeed,
  fogDensity,
  geometry,
  paletteOf,
  qualityOf,
} from "./lattice.js";

describe("flySpeed", () => {
  it("is Speed × SPEED_UNIT cells/s plus a beat surge scaled by Reactivity", () => {
    expect(flySpeed(2, 0, 1, false)).toBeCloseTo(2 * SPEED_UNIT, 9);
    expect(flySpeed(2, 1, 1, false)).toBeCloseTo(2 * SPEED_UNIT * (1 + SURGE), 9);
    expect(flySpeed(2, 0.5, 2, false)).toBeCloseTo(2 * SPEED_UNIT * (1 + SURGE), 9);
    expect(flySpeed(2, 1, 0, false)).toBeCloseTo(2 * SPEED_UNIT, 9);
    expect(SURGE).toBeLessThanOrEqual(0.6); // a push forward, not a lurch
  });

  it("slows a lot under Reduce motion while Speed is at its default, and drops the surge", () => {
    expect(flySpeed(DEFAULT_SPEED, 1, 2, true)).toBeCloseTo(REDUCED_SPEED * SPEED_UNIT, 9);
    expect(REDUCED_SPEED).toBeLessThanOrEqual(0.3 * DEFAULT_SPEED);
    // A Speed the user picked is respected (but still no surge).
    expect(flySpeed(1.7, 1, 1, true)).toBeCloseTo(1.7 * SPEED_UNIT, 9);
  });
});

describe("paletteOf", () => {
  /** @param {string} name */
  const pal = (name) => {
    const out = new Float32Array(PALETTE_FLOATS);
    paletteOf(name, out);
    const v = (/** @type {number} */ i) => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
    return { bg: v(0), surface: v(1), x: v(2), y: v(3), z: v(4), glow: v(5), ink: out[18] };
  };
  const lum = (/** @type {number[]} */ c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  it("offers a cool metallic, a warm brass and an ink-on-paper palette", () => {
    expect(PALETTES).toEqual(["steel", "brass", "ink"]);
    const steel = pal("steel");
    const brass = pal("brass");
    const ink = pal("ink");
    expect(steel.surface[2]).toBeGreaterThan(steel.surface[0]); // cool
    expect(brass.surface[0]).toBeGreaterThan(1.5 * brass.surface[2]); // warm
    for (const p of [steel, brass]) {
      expect(lum(p.bg)).toBeLessThan(0.05);
      expect(p.ink).toBe(0);
    }
    // Cream paper, dark lattice; light on paper is drawn as ink, not added.
    expect(lum(ink.bg)).toBeGreaterThan(0.6);
    expect(ink.bg[0]).toBeGreaterThan(ink.bg[2]);
    expect(lum(ink.surface)).toBeLessThan(0.05);
    expect(ink.ink).toBe(1);
    // Each axis has its own colour.
    for (const p of [steel, brass, ink]) {
      expect(p.x).not.toEqual(p.y);
      expect(p.y).not.toEqual(p.z);
    }
  });

  it("falls back to steel for an unknown name, and returns the ink flag", () => {
    const out = new Float32Array(PALETTE_FLOATS);
    paletteOf("nope", out);
    const steel = new Float32Array(PALETTE_FLOATS);
    paletteOf("steel", steel);
    expect(out).toEqual(steel);
  });
});

describe("qualityOf, geometry, fogDensity", () => {
  it("Quality picks the render scale and march budget; unknown → medium", () => {
    expect(QUALITIES).toEqual(["low", "medium", "high"]);
    const [lo, med, hi] = QUALITIES.map(qualityOf);
    expect(lo.scale).toBeLessThan(med.scale);
    expect(med.scale).toBeLessThan(hi.scale);
    expect(hi.scale).toBeLessThanOrEqual(1);
    expect(lo.scale).toBeGreaterThanOrEqual(0.4);
    expect(lo.steps).toBeLessThan(hi.steps);
    expect(qualityOf("bogus")).toBe(med);
  });

  it("Rod thickness sets the rods and the cubes, which always leave the camera's channel clear", () => {
    const g = new Float32Array(3);
    let prevRod = 0;
    for (let t = THICKNESS.min - 0.05; t <= THICKNESS.max + 0.05; t += 0.005) {
      geometry(t, g);
      const [rod, half, round] = g;
      expect(rod).toBeGreaterThanOrEqual(prevRod);
      prevRod = rod;
      expect(half).toBeGreaterThan(rod * 1.3); // the cube reads as a node, not a bulge
      expect(round).toBeGreaterThan(0);
      expect(round).toBeLessThan(half);
      // The camera keeps ≥ 0.6 from nodes and ≥ 0.45 from rod axes (lattice-camera.test.js).
      expect(Math.sqrt(3) * (half - round) + round).toBeLessThan(0.5);
      expect(rod).toBeLessThan(0.3);
    }
    geometry(THICKNESS.min - 1, g);
    const lo = g[0];
    geometry(THICKNESS.min, g);
    expect(g[0]).toBe(lo); // clamped
    geometry(THICKNESS.default, g);
    expect(g[0]).toBeCloseTo(THICKNESS.default, 6);
  });

  it("Fog thickens monotonically from a faint haze", () => {
    expect(fogDensity(0)).toBeGreaterThan(0);
    expect(fogDensity(0)).toBeLessThan(0.05);
    let prev = 0;
    for (let f = 0; f <= 1; f += 0.1) {
      expect(fogDensity(f)).toBeGreaterThan(prev);
      prev = fogDensity(f);
    }
    // At the default (0.5) a cube 8 cells away is about half visible (the shader mixes the fog in
    // display space, so this is what the eye sees).
    expect(Math.exp(-8 * fogDensity(0.5))).toBeGreaterThan(0.35);
    expect(Math.exp(-8 * fogDensity(0.5))).toBeLessThan(0.65);
  });
});

describe("createAxisLight", () => {
  /** Bands with `lo..hi` (inclusive) at `v`, the rest silent. */
  const bandsWith = (/** @type {number} */ lo, /** @type {number} */ hi, v = 0.6) => {
    const b = new Float32Array(64);
    for (let i = lo; i <= hi; i++) b[i] = v;
    return b;
  };

  it("lights each axis from its part of the spectrum: x bass, y mids, z treble", () => {
    for (const [lo, hi, axis] of [
      [0, 15, 0],
      [16, 39, 1],
      [40, 63, 2],
    ]) {
      const a = createAxisLight();
      const b = bandsWith(lo, hi);
      for (let f = 0; f < 120; f++) a.step(b, 1 / 60, 1, false);
      for (let k = 0; k < 3; k++) {
        if (k === axis) expect(a.light[k]).toBeGreaterThan(0.4);
        else expect(a.light[k]).toBeLessThan(0.01);
      }
    }
  });

  it("eases in (no snap), scales with Reactivity, and is much smaller with Reduce flashing", () => {
    const b = bandsWith(0, 63);
    const run = (/** @type {number} */ react, /** @type {boolean} */ reduce, frames = 60) => {
      const a = createAxisLight();
      /** @type {number[]} */
      const xs = [];
      for (let f = 0; f < frames; f++) xs.push(a.step(b, 1 / 60, react, reduce).light[0]);
      return xs;
    };
    const full = run(1, false);
    expect(full[0]).toBeLessThan(0.15 * full[59]);
    expect(full[35]).toBeGreaterThan(0.85 * full[59]);
    for (let f = 1; f < 60; f++) expect(full[f] - full[f - 1]).toBeLessThan(0.12);
    expect(run(0, false)[59]).toBe(0);
    expect(run(2, false)[59]).toBeCloseTo(2 * full[59], 3);
    const reduced = run(1, true);
    expect(Math.max(...reduced)).toBeLessThanOrEqual(REDUCED_AXIS * Math.max(...full) + 1e-6);
    expect(REDUCED_AXIS).toBeLessThanOrEqual(0.4);
  });

  it("is dark in silence", () => {
    const a = createAxisLight();
    for (let f = 0; f < 60; f++) a.step(new Float32Array(64), 1 / 60, 2, false);
    expect(Array.from(a.light)).toEqual([0, 0, 0]);
  });
});

describe("motionScale", () => {
  it("slows the rods' running light and shortens the beat pulses' travel a lot under Reduce motion", () => {
    expect(motionScale(false)).toBe(1);
    expect(motionScale(true)).toBe(REDUCED_MOTION);
    expect(REDUCED_MOTION).toBeLessThanOrEqual(0.35);
  });
});
