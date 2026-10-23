// @ts-check
import { describe, expect, it } from "vitest";
import { createFaceHistory } from "./lattice-history.js";

describe("createFaceHistory", () => {
  it("writes one row per push into a ring, newest at `head`", () => {
    const h = createFaceHistory(64, 4);
    const bands = new Float32Array(64);
    const wave = new Float32Array(2048);
    expect(h.head).toBe(0);
    const heads = [];
    for (let k = 0; k < 6; k++) heads.push(h.push(bands, wave, 1));
    expect(heads).toEqual([1, 2, 3, 0, 1, 2]);
    expect(h.head).toBe(2);
    expect(h.row.length).toBe(64 * 4);
  });

  it("stores the band levels (× gain) in red and the waveform's signed peaks in green", () => {
    const h = createFaceHistory(32, 8);
    const bands = new Float32Array(64);
    for (let i = 0; i < 64; i++) bands[i] = i / 63;
    const wave = new Float32Array(2048);
    // Column 3 of 32 covers samples 192–255: a lone negative spike there.
    wave[200] = -0.5;
    wave[100] = 0.9; // column 1
    h.push(bands, wave, 1);
    const r = (/** @type {number} */ i) => h.row[i * 4];
    const g = (/** @type {number} */ i) => h.row[i * 4 + 1];
    expect(r(0)).toBe(Math.round(255 * (0.5 / 63)));
    // Column i covers bands 2i and 2i + 1: their mean.
    expect(r(10)).toBe(Math.round((255 * (20.5 / 63))));
    expect(r(31)).toBe(Math.round((255 * (62.5 / 63))));
    expect(g(0)).toBe(128);
    expect(g(1)).toBe(Math.round(127.5 + 127.5 * 0.9));
    expect(g(3)).toBe(Math.round(127.5 - 127.5 * 0.5));
    expect(h.row[3]).toBe(255);
    // Gain scales (Reactivity) and clamps.
    h.push(bands, wave, 2);
    expect(r(10)).toBe(Math.round(255 * ((2 * 20.5) / 63)));
    expect(r(31)).toBe(255);
    h.push(bands, wave, 0);
    expect(r(31)).toBe(0);
  });
});
