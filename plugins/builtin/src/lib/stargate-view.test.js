// @ts-check
import { describe, expect, it } from "vitest";
import { planeHit, rowAge } from "./stargate-view.js";

describe("planeHit", () => {
  const hit = { z: 0, u: 0, side: 0 };

  it("puts the horizon at the screen centre line: depth grows without bound as y → 0", () => {
    planeHit(0.3, 0, 0, 1, hit);
    expect(hit.z).toBe(Infinity);
    let prev = 0;
    for (const y of [1, 0.5, 0.1, 0.01, 0.001]) {
      planeHit(0.2, y, 0, 1, hit);
      expect(hit.z).toBeGreaterThan(prev);
      prev = hit.z;
    }
  });

  it("hits two symmetric planes: mirrored screen points share depth and lateral, opposite sides", () => {
    const a = { z: 0, u: 0, side: 0 };
    for (const [x, y] of [[0.4, 0.3], [-1.2, 0.8], [0, 0.05]]) {
      planeHit(x, y, 0, 1.5, hit);
      planeHit(x, -y, 0, 1.5, a);
      expect(a.z).toBeCloseTo(hit.z, 9);
      expect(a.u).toBeCloseTo(hit.u, 9);
      expect([hit.side, a.side]).toEqual([1, -1]);
      expect(hit.z).toBeCloseTo(1.5 / y, 9); // plane at distance h
      expect(hit.u).toBeCloseTo(x * hit.z, 9); // u = x·z
    }
  });

  it("rolls the camera: the image turns counter-clockwise by the roll angle, perspective intact", () => {
    const ref = { z: 0, u: 0, side: 0 };
    for (const roll of [Math.PI / 2, 0.3, -1.1, 2.5]) {
      for (const [x, y] of [[0.4, 0.3], [-1.2, -0.8], [0.1, 0.6]]) {
        planeHit(x, y, 0, 1, ref);
        // The unrolled point, turned counter-clockwise by `roll`, is where it appears on screen.
        const rx = x * Math.cos(roll) - y * Math.sin(roll);
        const ry = x * Math.sin(roll) + y * Math.cos(roll);
        planeHit(rx, ry, roll, 1, hit);
        expect(hit.z, `${roll}`).toBeCloseTo(ref.z, 9);
        expect(hit.u, `${roll}`).toBeCloseTo(ref.u, 9);
        expect(hit.side).toBe(ref.side);
      }
    }
    // A quarter turn: the upper plane's centre line now lies to the left of centre.
    planeHit(-0.5, 0, Math.PI / 2, 1, hit);
    expect([hit.z, hit.u, hit.side]).toEqual([2, expect.closeTo(0, 9), 1]);
  });
});

describe("rowAge", () => {
  it("puts the newest row at the far depth and older rows nearer the viewer", () => {
    expect(rowAge(12, 12, 0.5, 0)).toBe(0);
    expect(rowAge(11, 12, 0.5, 0)).toBe(2);
    expect(rowAge(2, 12, 0.5, 0)).toBe(20);
  });

  it("moves every row toward the viewer as the push clock advances (travel)", () => {
    // Row of age 3 sits at depth zFar - (3 + frac)·D: nearer as frac grows, one row-depth per push.
    const D = 0.25;
    let prev = Infinity;
    for (let frac = 0; frac < 1; frac += 0.1) {
      const z = 12 - (3 + frac) * D;
      expect(rowAge(z, 12, D, frac)).toBeCloseTo(3, 9);
      expect(z).toBeLessThan(prev);
      prev = z;
    }
  });
});
