// @ts-check
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK,
  LOOKS,
  compositeAlpha,
  lookDefines,
  lookOf,
  MATERIAL_FLOATS,
  paletteMaterial,
  shadingSamples,
  tone,
  toneInverse,
} from "./lattice-look.js";

/** shade.glsl's loop caps (SHADOW_CAP, AO_CAP). */
const SHADOW_CAP_GLSL = 32;
const AO_CAP_GLSL = 8;

describe("lookOf", () => {
  it("maps the Look param to classic or cinematic (unknown → the default)", () => {
    expect(LOOKS).toEqual(["classic", "cinematic"]);
    expect(lookOf("classic")).toBe("classic");
    expect(lookOf("cinematic")).toBe("cinematic");
    expect(lookOf("no-such")).toBe(DEFAULT_LOOK);
    expect(lookOf(undefined)).toBe(DEFAULT_LOOK);
    expect(LOOKS).toContain(DEFAULT_LOOK);
  });

  it("adds no define for classic (its shader text is unchanged) and CINEMATIC for cinematic", () => {
    expect(lookDefines("classic")).toEqual([]);
    expect(lookDefines("cinematic")).toEqual(["CINEMATIC"]);
    expect(lookDefines("no-such")).toEqual(lookDefines(DEFAULT_LOOK));
  });
});

describe("tone", () => {
  it("maps 0 to 0, rises strictly until it saturates at 1, and never exceeds 1", () => {
    expect(tone(0)).toBe(0);
    let prev = 0;
    let saturated = false;
    for (let i = 1; i <= 64000; i++) {
      const x = i / 1000;
      const y = tone(x);
      expect(y).toBeLessThanOrEqual(1);
      if (saturated) expect(y).toBe(1);
      else if (y === 1) saturated = true;
      else expect(y, `x = ${x}`).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it("is a filmic curve: a toe below the identity in the darks, a shoulder toward white", () => {
    expect(tone(0.002)).toBeLessThan(0.002);
    expect(tone(4)).toBeGreaterThan(0.9);
    expect(tone(1)).toBeGreaterThan(0.5);
  });

  it("inverts exactly (display-referred colours such as the fog background map back to HDR)", () => {
    for (const x of [0, 0.001, 0.01, 0.05, 0.2, 0.5, 1, 2, 5]) {
      expect(toneInverse(tone(x))).toBeCloseTo(x, 6);
    }
    // The palettes' backgrounds and ink colours (linear) all land inside the curve's range.
    for (const y of [0.003, 0.0044, 0.007, 0.86, 0.79, 0.64]) {
      expect(tone(toneInverse(y))).toBeCloseTo(y, 9);
    }
  });
});

describe("compositeAlpha", () => {
  it("is the brightest channel where nothing covers the pixel: light over the desktop", () => {
    expect(compositeAlpha(0.2, 0.5, 0.1, 0)).toBe(0.5);
    expect(compositeAlpha(0, 0, 0, 0)).toBe(0);
  });

  it("never drops below any channel (valid premultiplied colour), nor below the coverage", () => {
    for (const [r, g, b, c] of [
      [0.9, 0.1, 0.1, 0.3],
      [0.1, 0.1, 0.1, 0.8],
      [1.2, 0.3, 0.3, 0],
    ]) {
      const a = compositeAlpha(r, g, b, c);
      expect(a).toBeGreaterThanOrEqual(Math.min(1, Math.max(r, g, b)));
      expect(a).toBeGreaterThanOrEqual(c);
      expect(a).toBeLessThanOrEqual(1);
    }
    // Background "fog" covers every pixel: opaque.
    expect(compositeAlpha(0.01, 0.02, 0.03, 1)).toBe(1);
  });
});

describe("shadingSamples", () => {
  it("lowers the shadow and AO sample counts with Quality (unknown → medium)", () => {
    const lo = shadingSamples("low");
    const med = shadingSamples("medium");
    const hi = shadingSamples("high");
    expect(lo.shadow).toBeLessThan(med.shadow);
    expect(med.shadow).toBeLessThan(hi.shadow);
    expect(lo.ao).toBeLessThan(med.ao);
    expect(med.ao).toBeLessThanOrEqual(hi.ao);
    expect(lo.ao).toBeGreaterThanOrEqual(2);
    expect(hi.shadow).toBeLessThanOrEqual(SHADOW_CAP_GLSL);
    expect(hi.ao).toBeLessThanOrEqual(AO_CAP_GLSL);
    expect(shadingSamples("no-such")).toEqual(med);
  });
});

describe("paletteMaterial", () => {
  it("maps each palette to a physically plausible material: f0, roughness, metalness", () => {
    const m = new Float32Array(MATERIAL_FLOATS);
    // Steel: iron's measured f0 (≈ 0.56 neutral), a little blued; a metal.
    paletteMaterial("steel", m);
    expect(m[4]).toBe(1);
    for (let c = 0; c < 3; c++) expect(m[c]).toBeGreaterThan(0.4);
    expect(m[2]).toBeGreaterThanOrEqual(m[0]);
    expect(m[3]).toBeGreaterThan(0.15);
    expect(m[3]).toBeLessThan(0.6);
    // Brass: a warm metal, f0 red > green > blue, bright.
    paletteMaterial("brass", m);
    expect(m[4]).toBe(1);
    expect(m[0]).toBeGreaterThan(m[1]);
    expect(m[1]).toBeGreaterThan(m[2]);
    expect(m[0]).toBeGreaterThan(0.8);
    // Ink on paper: a dielectric (f0 0.04, IOR ≈ 1.5), rough.
    paletteMaterial("ink", m);
    expect(m[4]).toBe(0);
    for (let c = 0; c < 3; c++) expect(m[c]).toBeCloseTo(0.04, 6);
    expect(m[3]).toBeGreaterThan(0.4);
    // Unknown → steel.
    const s = paletteMaterial("steel", new Float32Array(MATERIAL_FLOATS));
    expect(paletteMaterial("no-such", m)).toEqual(s);
  });
});
