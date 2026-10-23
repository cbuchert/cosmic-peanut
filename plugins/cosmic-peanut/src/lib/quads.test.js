// @ts-check
import { describe, expect, it } from "vitest";
import { RESTART } from "./geometry.js";
import { EXTENT_SIGMAS, buildQuadGrid, coverage, erf, quadExtent } from "./quads.js";

describe("buildQuadGrid", () => {
  const N = 3;
  const P = 5;
  const { verts, indices } = buildQuadGrid(N, P);

  it("has two vertices per point, one each side of the line: x = 2j + side, y = ring", () => {
    expect(verts).toBeInstanceOf(Uint16Array);
    expect(verts.length).toBe(N * P * 2 * 2);
    const seen = new Set();
    for (let v = 0; v < verts.length; v += 2) seen.add(`${verts[v]},${verts[v + 1]}`);
    expect(seen.size).toBe(N * P * 2);
    for (let i = 0; i < N; i++) for (let j = 0; j < P; j++) for (const side of [0, 1]) expect(seen.has(`${2 * j + side},${i}`)).toBe(true);
  });

  it("is one triangle strip per ring, zig-zagging across the line, with a restart between rings", () => {
    expect(indices).toBeInstanceOf(Uint32Array);
    expect(indices.length).toBe(N * (2 * P + 1));
    for (let i = 0; i < N; i++) {
      const strip = indices.subarray(i * (2 * P + 1), (i + 1) * (2 * P + 1));
      expect(strip[2 * P]).toBe(RESTART);
      for (let k = 0; k < 2 * P; k++) {
        const x = verts[strip[k] * 2];
        const y = verts[strip[k] * 2 + 1];
        expect(y).toBe(i); // stays on its ring
        expect(x >> 1).toBe(k >> 1); // walks the points in order
        expect(x & 1).toBe(k & 1); // alternates sides
      }
    }
  });

  it("fits 16-bit attributes for the pack's largest grids (512 points + 1, 400 rings)", () => {
    const g = buildQuadGrid(400, 513);
    let max = 0;
    for (const v of g.verts) max = Math.max(max, v);
    expect(max).toBe(2 * 512 + 1);
  });
});

describe("erf (Abramowitz & Stegun 7.1.26)", () => {
  it("matches reference values to 2e-7", () => {
    for (const [x, y] of [
      [0, 0],
      [0.5, 0.5204998778],
      [1, 0.8427007929],
      [2, 0.9953222650],
      [-1, -0.8427007929],
    ]) {
      expect(Math.abs(erf(x) - y)).toBeLessThan(2e-7);
    }
  });
});

describe("coverage (a line of half width h convolved with a Gaussian of sigma s)", () => {
  /** ∫ coverage dd over ±e (the whole profile by default), midpoint rule. @param {number} h @param {number} s */
  const area = (h, s, e = h + 10 * s) => {
    const n = 4000;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += coverage(-e + ((k + 0.5) * 2 * e) / n, h, s);
    return (sum * 2 * e) / n;
  };

  it("conserves the line's energy: the profile always integrates to its width 2h", () => {
    for (const h of [0.5, 1, 2.5]) for (const s of [0.3, 0.5, 2, 6]) expect(area(h, s)).toBeCloseTo(2 * h, 3);
  });

  it("loses under 1% of it outside the quad", () => {
    for (const h of [0.5, 1, 2.5]) for (const s of [0.3, 0.5, 2, 6]) expect(area(h, s, quadExtent(h, s)) / (2 * h)).toBeGreaterThan(0.99);
  });

  it("is symmetric, at most 1, and about 1 in the core of a wide, sharp line", () => {
    for (const d of [0, 0.3, 1.1, 2.7]) expect(coverage(d, 1, 0.5)).toBeCloseTo(coverage(-d, 1, 0.5), 12);
    for (let d = -5; d <= 5; d += 0.1) expect(coverage(d, 2, 0.4)).toBeLessThanOrEqual(1);
    expect(coverage(0, 3, 0.4)).toBeGreaterThan(0.999);
  });

  it("spreads wider and dimmer as sigma grows (the depth-of-field blur)", () => {
    expect(coverage(0, 1, 3)).toBeLessThan(coverage(0, 1, 0.5));
    expect(coverage(3, 1, 3)).toBeGreaterThan(coverage(3, 1, 0.5));
  });

  it("has almost nothing left at the quad's edge, h + EXTENT_SIGMAS·sigma", () => {
    expect(EXTENT_SIGMAS).toBeGreaterThanOrEqual(2.5);
    for (const [h, s] of [
      [1, 0.5],
      [0.5, 4],
    ]) {
      expect(coverage(quadExtent(h, s), h, s)).toBeLessThan(0.01);
    }
  });
});
