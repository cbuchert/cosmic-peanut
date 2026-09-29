// @ts-check
import { describe, expect, it } from "vitest";
import { blobSdf, boundRadius, bridgeDistance, smin } from "./metaball.js";
import { tetraVertices } from "./tetra-motion.js";

describe("smin", () => {
  it("is a union: never above min, equal to min once the two are more than k apart", () => {
    for (const [a, b] of [
      [0.3, 0.31],
      [-0.2, 0.1],
      [1, -1],
      [0.5, 0.5],
    ]) {
      expect(smin(a, b, 0.2)).toBeLessThanOrEqual(Math.min(a, b));
      expect(smin(a, b, 0.2)).toBe(smin(b, a, 0.2));
    }
    expect(smin(0.1, 0.6, 0.2)).toBe(0.1);
    expect(smin(0.5, 0.5, 0.2)).toBeCloseTo(0.5 - 0.05, 9); // deepest blend: k / 4 below
    expect(smin(0.2, 0.9, 0)).toBe(0.2); // k = 0 is a hard union
  });
});

describe("blobSdf", () => {
  const c = new Float32Array(12);
  const r = new Float32Array([0.3, 0.3, 0.3, 0.3]);
  /** Two balls on the x axis `d` apart; the other two far away. */
  const pair = (/** @type {number} */ d) => {
    c.set([-d / 2, 0, 0, d / 2, 0, 0, 0, 50, 0, 0, -50, 0]);
    return blobSdf(0, 0, 0, c, r, 0.24);
  };

  it("is the sphere distance near a lone ball", () => {
    c.set([0, 0, 0, 40, 0, 0, 0, 40, 0, 0, 0, 40]);
    expect(blobSdf(0.5, 0, 0, c, r, 0.24)).toBeCloseTo(0.2, 6);
    expect(blobSdf(0, 0, 0, c, r, 0.24)).toBeCloseTo(-0.3, 6);
  });

  it("pinches a liquid bridge between two balls closer than bridgeDistance, droplets beyond", () => {
    const dStar = bridgeDistance(0.3, 0.24);
    expect(dStar).toBeGreaterThan(0.6); // bridges reach past touching
    expect(pair(dStar * 0.95)).toBeLessThan(0); // midpoint is inside: a bridge
    expect(pair(dStar * 1.05)).toBeGreaterThan(0); // midpoint is outside: two droplets
  });
});

describe("boundRadius", () => {
  it("covers the whole blob at the largest balls and furthest bounce, in any orientation", () => {
    const k = 0.3;
    for (const [dist, rad] of [
      [0.2, 0.6], // squeezed together: one fused lump
      [0.9, 0.35],
      [1.6, 0.5], // burst apart
    ]) {
      const R = boundRadius(dist, rad, k);
      const v = tetraVertices(new Float32Array(12));
      const c = new Float32Array(12);
      const r = new Float32Array([rad, rad, rad, rad]);
      let nearest = Infinity;
      for (let a = 0; a < 6; a++) {
        // a few tumbles of the tetrahedron (rotate about z then x)
        const ca = Math.cos(a * 0.7);
        const sa = Math.sin(a * 0.7);
        for (let i = 0; i < 4; i++) {
          const x = v[i * 3] * ca - v[i * 3 + 1] * sa;
          const y = v[i * 3] * sa + v[i * 3 + 1] * ca;
          const z = v[i * 3 + 2];
          c[i * 3] = x * dist;
          c[i * 3 + 1] = (y * ca - z * sa) * dist;
          c[i * 3 + 2] = (y * sa + z * ca) * dist;
        }
        for (let j = 0; j < 400; j++) {
          // Fibonacci sphere of directions
          const zz = 1 - (2 * (j + 0.5)) / 400;
          const rr = Math.sqrt(1 - zz * zz);
          const ph = j * 2.399963;
          const d = blobSdf(R * rr * Math.cos(ph), R * rr * Math.sin(ph), R * zz, c, r, k);
          nearest = Math.min(nearest, d);
        }
      }
      expect(nearest, `${dist} ${rad}`).toBeGreaterThanOrEqual(0);
      expect(nearest, `${dist} ${rad} (not wastefully loose)`).toBeLessThan(0.35);
    }
  });
});
