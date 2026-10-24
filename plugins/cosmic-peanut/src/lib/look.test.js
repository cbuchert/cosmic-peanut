// @ts-check
import { describe, expect, it } from "vitest";
import { GRAIN_HZ, acesFilm, grainSeed, lookMode, tonePixel } from "./look.js";

describe("lookMode", () => {
  it("maps the Look select to classic or cinematic, classic for anything else", () => {
    expect(lookMode("classic")).toBe("classic");
    expect(lookMode("cinematic")).toBe("cinematic");
    expect(lookMode(undefined)).toBe("classic");
    expect(lookMode("bogus")).toBe("classic");
  });
});

describe("acesFilm (Narkowicz's ACES fit)", () => {
  it("is 0 at 0, rises strictly until it reaches 1 (its clamp) and never leaves [0, 1]", () => {
    expect(acesFilm(0)).toBe(0);
    let prev = 0;
    for (let x = 0.001; x < 64; x *= 1.05) {
      const y = acesFilm(x);
      if (prev < 1) expect(y).toBeGreaterThan(prev);
      else expect(y).toBe(1);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    expect(acesFilm(1e6)).toBe(1);
  });
});

describe("tonePixel", () => {
  const out = new Float32Array(4);
  it("is monotonic in each channel and stays in [0, 1]", () => {
    for (const ch of [0, 1, 2]) {
      let prev = -1;
      for (let x = 0; x < 40; x += 0.01) {
        const rgb = [0.2, 0.2, 0.2];
        rgb[ch] = x;
        tonePixel(rgb[0], rgb[1], rgb[2], 1, out);
        expect(out[ch]).toBeGreaterThanOrEqual(prev);
        expect(out[ch]).toBeLessThanOrEqual(1);
        prev = out[ch];
      }
    }
  });
  it("sets alpha to the brightest channel after tone mapping (premultiplied light)", () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [0.1, 0.5, 2],
      [8, 0.01, 0.3],
      [0.02, 0.02, 0.02],
    ]) {
      tonePixel(r, g, b, 1.3, out);
      expect(out[3]).toBe(Math.max(out[0], out[1], out[2]));
    }
  });
  it("shows mid light as a mid tone, rolls highlights off toward white, and scales with exposure", () => {
    tonePixel(0.2, 0.2, 0.2, 1, out); // linear light: a mid grey
    expect(out[0]).toBeGreaterThan(0.35);
    expect(out[0]).toBeLessThan(0.8);
    const mid = out[0];
    tonePixel(0.2, 0.2, 0.2, 2, out);
    expect(out[0]).toBeGreaterThan(mid);
    tonePixel(30, 30, 30, 1, out);
    expect(out[0]).toBeGreaterThan(0.97);
  });
  it("keeps black transparent and dim light dim (no lifted floor over the desktop)", () => {
    tonePixel(0, 0, 0, 1.3, out);
    expect([...out]).toEqual([0, 0, 0, 0]);
    tonePixel(1e-4, 1e-4, 1e-4, 1.3, out);
    expect(out[3]).toBeLessThan(0.02);
  });
});

describe("grainSeed", () => {
  it("steps at GRAIN_HZ, like film frames", () => {
    expect(grainSeed(0, false)).toBe(grainSeed(0.99 / GRAIN_HZ, false));
    expect(grainSeed(1.01 / GRAIN_HZ, false)).not.toBe(grainSeed(0, false));
  });
  it("is static under Reduce flashing", () => {
    const s = grainSeed(0, true);
    for (let t = 0; t < 30; t += 0.37) expect(grainSeed(t, true)).toBe(s);
  });
  it("stays a small number, exact in a float uniform", () => {
    for (let t = 0; t < 1e5; t += 917.3) {
      const s = grainSeed(t, false);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1024);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});
