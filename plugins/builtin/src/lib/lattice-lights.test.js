// @ts-check
import { describe, expect, it } from "vitest";
import {
  FRONT_LEAD,
  FRONT_WAKE,
  LIGHT_CAP,
  LIGHT_REACH,
  createLightPack,
  packPulseLights,
  pointPulseLight,
  strutFrontLights,
} from "./lattice-lights.js";

/** A sink that records every light added. */
function recorder() {
  /** @type {number[][]} */
  const lights = [];
  return {
    lights,
    /** @type {(ax: number, ay: number, az: number, bx: number, by: number, bz: number, p: number) => void} */
    add(ax, ay, az, bx, by, bz, p) {
      lights.push([ax, ay, az, bx, by, bz, p]);
    },
  };
}

/** One pulse slot's data: source xyz, front. */
const pulse = (/** @type {number[]} */ v) => Float32Array.from(v);

describe("createLightPack", () => {
  it("keeps the LIGHT_CAP lights nearest the focus, nearest first, and skips any beyond reach", () => {
    const pack = createLightPack();
    const a = pack.a;
    pack.begin(0, 0, 0);
    // 20 point lights along x at 0.1, 0.2, … 2.0 (added farthest first), and one out of reach.
    for (let i = 20; i >= 1; i--) pack.add(i / 10, 0, 0, i / 10, 0, 0, 1);
    pack.add(LIGHT_REACH + 0.1, 0, 0, LIGHT_REACH + 0.1, 0, 0, 5);
    pack.end();
    expect(pack.count).toBe(LIGHT_CAP);
    for (let i = 0; i < LIGHT_CAP; i++) expect(pack.a[i * 4]).toBeCloseTo((i + 1) / 10, 6);
    expect(pack.a).toBe(a); // the same arrays every frame
    pack.begin(0, 0, 0);
    pack.end();
    expect(pack.count).toBe(0);
  });

  it("measures a tube by its nearest point and fades its power to 0 at LIGHT_REACH (no pop)", () => {
    const pack = createLightPack();
    pack.begin(0, 0, 0);
    pack.add(-1, 0.5, 0, 1, 0.5, 0, 2); // passes 0.5 from the focus: full power
    pack.add(0, LIGHT_REACH * 0.99, 0, 0, LIGHT_REACH * 0.99, 1, 2); // at the edge: nearly 0
    pack.end();
    expect(pack.count).toBe(2);
    expect(pack.b[3]).toBeCloseTo(2, 6);
    expect(pack.b[7]).toBeGreaterThan(0);
    expect(pack.b[7]).toBeLessThan(0.01);
    expect([pack.a[0], pack.a[1], pack.b[0], pack.b[1]]).toEqual([-1, 0.5, 1, 0.5]);
  });
});

describe("strutFrontLights", () => {
  it("lights the six struts out of the source while the front is still near it", () => {
    const r = recorder();
    strutFrontLights(pulse([0, 0, 0, 0.3]), 0, 1.5, r);
    expect(r.lights).toHaveLength(6);
    for (const [ax, ay, az, bx, by, bz, p] of r.lights) {
      expect([ax, ay, az]).toEqual([0, 0, 0]);
      expect(Math.abs(bx) + Math.abs(by) + Math.abs(bz)).toBeCloseTo(0.3 + FRONT_LEAD, 6);
      expect(p).toBe(1.5);
    }
  });

  it("matches a brute-force walk of every strut: the part whose L1 distance is within the front", () => {
    for (const front of [0.9, 1.0, 2.3, 3]) {
      const src = [1, -2, 0];
      const r = recorder();
      strutFrontLights(pulse([0, 0, 0, 0, ...src, front]), 1, 1, r);
      /** @type {Set<string>} */
      const expected = new Set();
      const key = (/** @type {number[]} */ v) => v.map((x) => x.toFixed(4)).join(",");
      for (let x = -6; x <= 6; x++)
        for (let y = -8; y <= 4; y++)
          for (let z = -5; z <= 5; z++)
            for (let c = 0; c < 3; c++) {
              // The strut from node (x, y, z) to its +c neighbour; L1 along it is piecewise linear.
              const p = [x, y, z];
              const q = [x, y, z];
              q[c] += 1;
              const d0 = Math.abs(p[0] - src[0]) + Math.abs(p[1] - src[1]) + Math.abs(p[2] - src[2]);
              const d1 = Math.abs(q[0] - src[0]) + Math.abs(q[1] - src[1]) + Math.abs(q[2] - src[2]);
              const [near, far, dn] = d0 < d1 ? [p, q, d0] : [q, p, d1];
              const lo = Math.max(0, front - FRONT_WAKE - dn);
              const hi = Math.min(1, front + FRONT_LEAD - dn);
              if (!(lo < hi)) continue;
              const at = (/** @type {number} */ s) => near.map((n, i) => n + (far[i] - n) * s);
              expected.add(key([...at(lo), ...at(hi)]));
            }
      const got = new Set(r.lights.map((l) => key(l.slice(0, 6))));
      expect(got.size, `front ${front}`).toBe(r.lights.length); // no strut twice
      expect(got, `front ${front}`).toEqual(expected);
    }
  });
});

describe("pointPulseLight", () => {
  it("is one point light at the source (structures without struts)", () => {
    const r = recorder();
    pointPulseLight(pulse([2, 3, 4, 1.2]), 0, 0.7, r);
    expect(r.lights).toEqual([[2, 3, 4, 2, 3, 4, 0.7]]);
  });
});

describe("packPulseLights", () => {
  it("packs only the live pulses through the structure's light topology", () => {
    const pack = createLightPack();
    const pulses = { data: new Float32Array(8 * 4), amp: new Float32Array(8) };
    pulses.data.set([0, 0, 0, 0.3], 0);
    pulses.data.set([5, 0, 0, 0.3], 8);
    pulses.amp[0] = 1; // slot 1 idle; slot 2 live but out of reach
    pulses.amp[2] = 1;
    packPulseLights(pack, pulses, 0, 0, 0, strutFrontLights);
    expect(pack.count).toBe(6);
    packPulseLights(pack, pulses, 0, 0, 0, pointPulseLight);
    expect(pack.count).toBe(1);
  });
});
