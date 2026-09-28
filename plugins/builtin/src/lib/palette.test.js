// @ts-check
import { describe, expect, it } from "vitest";
import { PALETTES, paletteCoeffs } from "./palette.js";

/** Cosine palette a + b·cos(2π(c·t + d)) at t. @param {Float32Array} k @param {number} t */
const at = (k, t) => [0, 1, 2].map((i) => k[i] + k[3 + i] * Math.cos(2 * Math.PI * (k[6 + i] * t + k[9 + i])));

/** Hue sextant (0–5) and saturation of an rgb triple. @param {number[]} c */
function hsv(c) {
  const max = Math.max(...c);
  const min = Math.min(...c);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === c[0]) h = ((c[1] - c[2]) / d + 6) % 6;
    else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
  }
  return { sextant: Math.floor(h), sat: max > 0 ? d / max : 0 };
}

describe("paletteCoeffs", () => {
  it("selects a distinct cosine palette per name, film for anything unknown", () => {
    expect(PALETTES).toEqual(["film", "ember", "ice", "mono"]);
    const seen = new Set();
    for (const name of PALETTES) seen.add(String(paletteCoeffs(name, new Float32Array(12))));
    expect(seen.size).toBe(4);
    expect(paletteCoeffs("nope", new Float32Array(12))).toEqual(paletteCoeffs("film", new Float32Array(12)));
  });

  it("film sweeps saturated colour through most of the hue wheel; mono has no colour; all stay in 0-1", () => {
    const k = new Float32Array(12);
    for (const name of PALETTES) {
      paletteCoeffs(name, k);
      for (let t = 0; t < 1; t += 0.01) {
        for (const v of at(k, t)) {
          expect(v, name).toBeGreaterThanOrEqual(-1e-6);
          expect(v, name).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
    paletteCoeffs("film", k);
    const sextants = new Set();
    for (let t = 0; t < 1; t += 0.01) {
      const { sextant, sat } = hsv(at(k, t));
      if (sat > 0.6) sextants.add(sextant);
    }
    expect(sextants.size).toBeGreaterThanOrEqual(5); // red/magenta, amber, green, cyan, blue/violet
    paletteCoeffs("mono", k);
    for (let t = 0; t < 1; t += 0.05) expect(hsv(at(k, t)).sat).toBeLessThan(1e-6);
  });
});
