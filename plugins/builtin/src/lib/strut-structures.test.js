// @ts-check
/**
 * The strut-lattice structures (octet truss, diamond, bitruncated cubic honeycomb): their JS
 * mirrors of the shader's distance and pulse metric, checked against brute force over explicit
 * nodes and struts, and their channel walks.
 */
import { describe, expect, it } from "vitest";
import { THICKNESS } from "./lattice.js";
import * as bitruncated from "./structure-bitruncated.js";
import * as diamond from "./structure-diamond.js";
import * as octet from "./structure-octet.js";

/** @typedef {[number, number, number]} V3 */

/** Explicit nodes and struts of one structure around the origin (period 2), for brute force. */
function explicit(/** @type {"octet" | "diamond" | "bitruncated"} */ name) {
  /** @type {V3[]} */
  let nodes = [];
  const R = [-3, -2, -1, 0, 1, 2, 3, 4];
  const even = [];
  for (const x of R) for (const y of R) for (const z of R) if ((((x + y + z) % 2) + 2) % 2 === 0) even.push([x, y, z]);
  let bond = 0;
  if (name === "octet") {
    nodes = /** @type {V3[]} */ (even);
    bond = Math.SQRT2;
  } else if (name === "diamond") {
    nodes = /** @type {V3[]} */ ([...even, ...even.map(([x, y, z]) => [x + 0.5, y + 0.5, z + 0.5])]);
    bond = Math.sqrt(3) / 2;
  } else {
    const seen = new Set();
    for (const x of R) for (const y of R) for (const z of R) {
      if (((x % 2) + 2) % 2 !== ((y % 2) + 2) % 2 || ((y % 2) + 2) % 2 !== ((z % 2) + 2) % 2) continue;
      for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        for (let s = 0; s < 8; s++) {
          const v = [0, 1, 2].map((i) => [x, y, z][i] + 0.5 * p[i] * (s & (1 << i) ? -1 : 1));
          const k = v.join();
          if (!seen.has(k)) {
            seen.add(k);
            nodes.push(/** @type {V3} */ (v));
          }
        }
      }
    }
    bond = Math.SQRT2 / 2;
  }
  /** @type {[V3, V3][]} */
  const struts = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - bond) < 1e-9) struts.push([a, b]);
    }
  }
  return { nodes, struts, bond };
}

/** Distance from p to segment ab. @param {ArrayLike<number>} p @param {V3} a @param {V3} b */
function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}

/** Breadth-first hop counts on the strut graph from node `src`. @param {ReturnType<typeof explicit>} g @param {V3} src */
function hops(g, src) {
  const key = (/** @type {ArrayLike<number>} */ v) => Array.from(v, (x) => x.toFixed(3)).join();
  /** @type {Map<string, V3[]>} */
  const adj = new Map();
  for (const [a, b] of g.struts) {
    for (const [u, v] of [[a, b], [b, a]]) {
      const k = key(u);
      if (!adj.has(k)) adj.set(k, []);
      /** @type {V3[]} */ (adj.get(k)).push(v);
    }
  }
  const d = new Map([[key(src), 0]]);
  const q = [src];
  while (q.length) {
    const u = /** @type {V3} */ (q.shift());
    for (const v of adj.get(key(u)) ?? []) {
      if (d.has(key(v))) continue;
      d.set(key(v), /** @type {number} */ (d.get(key(u))) + 1);
      q.push(v);
    }
  }
  return { d, key };
}

/** A seeded uniform sampler. @param {number} s */
function rng(s) {
  let x = s >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const MODULES = { octet, diamond, bitruncated };

for (const [name, m] of Object.entries(MODULES)) {
  const g = explicit(/** @type {"octet" | "diamond" | "bitruncated"} */ (name));
  const geo = m.geometry(THICKNESS.default, new Float32Array(3));

  describe(`${name} distance`, () => {
    it("is the exact distance to its struts and nodes (brute force, many points)", () => {
      const r = rng(5);
      const out = new Float64Array(2);
      for (let i = 0; i < 3000; i++) {
        const p = [r() * 2, r() * 2, r() * 2];
        m.axisDistances(p, out);
        let s = Infinity;
        for (const [a, b] of g.struts) s = Math.min(s, segDist(p, a, b));
        let n = Infinity;
        for (const v of g.nodes) n = Math.min(n, Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]));
        expect(out[0]).toBeCloseTo(s, 9);
        expect(out[1]).toBeCloseTo(n, 9);
      }
    });

    it("the scene distance never exceeds the true distance to the surface (march-safe)", () => {
      const r = rng(9);
      for (let i = 0; i < 2000; i++) {
        const p = [r() * 2, r() * 2, r() * 2];
        const d = m.sceneDistance(p, geo);
        // The true distance is at least (distance to the nearest strut axis − radius) and the
        // nearest node's shape, which is what sceneDistance takes the minimum of; so compare
        // against the brute-force minimum of the same primitives.
        let best = Infinity;
        for (const [a, b] of g.struts) best = Math.min(best, segDist(p, a, b) - geo[0]);
        for (const v of g.nodes) best = Math.min(best, m.nodeShape([p[0] - v[0], p[1] - v[1], p[2] - v[2]], geo));
        expect(d).toBeLessThanOrEqual(best + 1e-9);
        expect(d).toBeGreaterThan(best - 1e-9);
      }
    });
  });

  describe(`${name} pulses`, () => {
    it("launch from the nearest node", () => {
      const r = rng(3);
      const out = new Float64Array(3);
      const src = name === "diamond" ? g.nodes.filter((v) => Number.isInteger(v[0])) : g.nodes;
      for (let i = 0; i < 200; i++) {
        const p = [r() * 2, r() * 2, r() * 2];
        m.pulseSource(p, out);
        let best = Infinity;
        for (const v of src) best = Math.min(best, Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]));
        expect(Math.hypot(p[0] - out[0], p[1] - out[1], p[2] - out[2])).toBeCloseTo(best, 9);
      }
    });

    it("measure the distance along the struts (the graph distance) from the source node", () => {
      const src = /** @type {V3} */ (name === "bitruncated" ? [1, 0.5, 0] : [0, 0, 0]);
      const { d, key } = hops(g, src);
      let worst = 0;
      let count = 0;
      for (const [a, b] of g.struts) {
        const ka = d.get(key(a));
        const kb = d.get(key(b));
        if (ka === undefined || kb === undefined || Math.max(ka, kb) > 4) continue;
        for (const t of [0, 0.25, 0.5, 0.8, 1]) {
          const p = [0, 1, 2].map((c) => a[c] + t * (b[c] - a[c]));
          const want = Math.min(ka + t, kb + 1 - t) * g.bond;
          const got = m.pulseMetric(p, src);
          worst = Math.max(worst, Math.abs(got - want) / g.bond);
          count++;
          if (name !== "bitruncated") expect(got, `${a} → ${b} at ${t}`).toBeCloseTo(want, 9);
        }
      }
      expect(count).toBeGreaterThan(100);
      // The sodalite net (the honeycomb's edges) has no closed form: its nodes are estimated
      // from their distance, so within about a hop and a half up to 4 hops out.
      if (name === "bitruncated") expect(worst).toBeLessThan(1.6);
    });
  });

  describe(`${name} channel walk`, () => {
    it("keeps the camera's path far from the thickest struts and largest nodes", () => {
      for (const seed of [1, 7, 42, 99]) {
        const cam = m.camera(seed);
        let clear = Infinity;
        for (let f = 0; f < 240 * 60; f++) {
          if (f % 120 === 0) cam.beat();
          cam.update(1 / 240, 2);
          clear = Math.min(clear, m.clearance(cam.pos));
        }
        expect(clear, `seed ${seed}`).toBeGreaterThan(0.18);
      }
    });
  });
}
