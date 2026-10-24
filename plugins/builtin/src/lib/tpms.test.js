// @ts-check
import { describe, expect, it } from "vitest";
import { THICKNESS } from "./lattice.js";
import { SWELL_MAX, TPMS, createMorph, sheet, tpmsClearance, wallPoint } from "./tpms.js";

const NAMES = /** @type {const} */ (["gyroid", "schwarz-p", "schwarz-d"]);
const TAU = 2 * Math.PI;

/** A seeded uniform generator (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The gradient's largest eigenvalue magnitude (symmetrized finite-difference Hessian). */
function hessNorm(/** @type {import('./tpms.js').Surface} */ s, /** @type {number[]} */ q) {
  const h = 1e-5;
  const g1 = new Float64Array(3);
  const g0 = new Float64Array(3);
  const H = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let j = 0; j < 3; j++) {
    const a = q.slice();
    const b = q.slice();
    a[j] += h;
    b[j] -= h;
    s.grad(a[0], a[1], a[2], g1);
    s.grad(b[0], b[1], b[2], g0);
    for (let i = 0; i < 3; i++) H[i][j] = (g1[i] - g0[i]) / (2 * h);
  }
  // Power iteration on the symmetrized matrix (its spectral norm).
  const M = H.map((r, i) => r.map((v, j) => (v + H[j][i]) / 2));
  let v = [0.6, 0.5, 0.62];
  let lam = 0;
  for (let it = 0; it < 60; it++) {
    const w = M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    lam = Math.hypot(w[0], w[1], w[2]);
    if (lam < 1e-12) return 0;
    v = w.map((x) => x / lam);
  }
  return lam;
}

describe("TPMS level-set functions", () => {
  it("the gradient is the level function's derivative", () => {
    const r = rng(3);
    const g = new Float64Array(3);
    for (const name of NAMES) {
      const s = TPMS[name];
      for (let i = 0; i < 200; i++) {
        const q = [r() * TAU, r() * TAU, r() * TAU];
        const f = s.grad(q[0], q[1], q[2], g);
        expect(f).toBeCloseTo(s.f(q[0], q[1], q[2]), 12);
        for (let c = 0; c < 3; c++) {
          const a = q.slice();
          const b = q.slice();
          a[c] += 1e-6;
          b[c] -= 1e-6;
          expect(g[c], name).toBeCloseTo((s.f(a[0], a[1], a[2]) - s.f(b[0], b[1], b[2])) / 2e-6, 6);
        }
      }
    }
  });

  it("the labyrinth's net nodes are the level function's maxima (fmax, zero gradient)", () => {
    const g = new Float64Array(3);
    for (const name of NAMES) {
      const s = TPMS[name];
      for (const n of s.nodes) {
        const q = n.map((v) => (v * TAU) / 8);
        expect(s.grad(q[0], q[1], q[2], g), name).toBeCloseTo(s.fmax, 9);
        expect(Math.hypot(g[0], g[1], g[2]), name).toBeLessThan(1e-9);
      }
    }
  });

  it("lip and hess bound the real gradient and Hessian over a dense sample (and are tight)", () => {
    const g = new Float64Array(3);
    for (const name of NAMES) {
      const s = TPMS[name];
      const r = rng(11);
      let gMax = 0;
      /** @type {number[][]} */
      const top = [];
      // A 48³ grid plus 20 000 random points, then hill-climb from the best grid points.
      const n = 48;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          for (let k = 0; k < n; k++) {
            const q = [(i * TAU) / n, (j * TAU) / n, (k * TAU) / n];
            s.grad(q[0], q[1], q[2], g);
            const m = Math.hypot(g[0], g[1], g[2]);
            if (m > gMax - 1e-3) top.push(q);
            gMax = Math.max(gMax, m);
          }
      for (let i = 0; i < 20000; i++) {
        s.grad(r() * TAU, r() * TAU, r() * TAU, g);
        gMax = Math.max(gMax, Math.hypot(g[0], g[1], g[2]));
      }
      for (const q0 of top.slice(-40)) {
        const q = q0.slice();
        let step = 0.05;
        let best = 0;
        for (let it = 0; it < 400; it++) {
          s.grad(q[0], q[1], q[2], g);
          best = Math.hypot(g[0], g[1], g[2]);
          const c = it % 3;
          const sign = it % 6 < 3 ? 1 : -1;
          q[c] += sign * step;
          s.grad(q[0], q[1], q[2], g);
          if (Math.hypot(g[0], g[1], g[2]) < best) q[c] -= sign * step;
          if (it % 60 === 59) step /= 3;
        }
        gMax = Math.max(gMax, best);
      }
      expect(gMax, `${name} gradient`).toBeLessThanOrEqual(s.lip);
      expect(gMax, `${name} gradient`).toBeGreaterThan(s.lip * 0.97);

      let hMax = 0;
      for (let i = 0; i < 6000; i++) hMax = Math.max(hMax, hessNorm(s, [r() * TAU, r() * TAU, r() * TAU]));
      expect(hMax, `${name} Hessian`).toBeLessThanOrEqual(s.hess);
      expect(hMax, `${name} Hessian`).toBeGreaterThan(s.hess * 0.95);
    }
  });

  it("the march's step (surfGrad / lip) never passes the sheet: |f| − t over k·lip is a true lower bound", () => {
    // Sphere-trace random rays with the shader's step and compare with a fine brute-force search.
    for (const name of NAMES) {
      const s = TPMS[name];
      const k = TAU / s.period;
      const u = new Float64Array(4);
      sheet(s, THICKNESS.default, 0.2, 0.3, u);
      const sdf = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
        (Math.abs(s.f(k * x, k * y, k * z) - u[1]) - u[2]) * u[3];
      const step = s.surfGrad / s.lip;
      const r = rng(5);
      for (let i = 0; i < 300; i++) {
        const o = [r() * s.period, r() * s.period, r() * s.period];
        if (sdf(o[0], o[1], o[2]) <= 0) continue;
        const d = [r() - 0.5, r() - 0.5, r() - 0.5];
        const l = Math.hypot(d[0], d[1], d[2]);
        const dir = d.map((v) => v / l);
        let t = 0;
        let hit = -1;
        for (let it = 0; it < 400 && t < 12; it++) {
          const e = sdf(o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t);
          if (e < 1e-5) {
            hit = t;
            break;
          }
          t += step * e;
        }
        if (hit < 0) continue;
        // Brute force: no point before the hit is inside the sheet.
        for (let x = 0; x < hit; x += 0.002) expect(sdf(o[0] + dir[0] * x, o[1] + dir[1] * x, o[2] + dir[2] * x)).toBeGreaterThan(0);
      }
    }
  });
});

describe("sheet", () => {
  it("writes k, the level offset, the half-thickness and 1/(k surfGrad); music thickens and shifts within bounds", () => {
    for (const name of NAMES) {
      const s = TPMS[name];
      const out = new Float32Array(4);
      sheet(s, THICKNESS.default, 0, 0, out);
      expect(out[0]).toBeCloseTo(TAU / s.period, 6);
      expect(out[1]).toBe(0);
      const t0 = out[2];
      expect(out[3]).toBeCloseTo(1 / ((TAU / s.period) * s.surfGrad), 6);
      // The half-thickness, in cells near the walls, follows the Rod thickness.
      expect(t0 * out[3]).toBeGreaterThan(0.05);
      expect(t0 * out[3]).toBeLessThan(0.15);
      sheet(s, THICKNESS.default, SWELL_MAX, 1, out);
      expect(out[2]).toBeCloseTo(t0 * (1 + SWELL_MAX), 6);
      expect(out[1]).toBeCloseTo(s.offset, 6);
      // Out-of-range music is clamped to the worst case.
      sheet(s, 99, 9, -9, out);
      const w = new Float32Array(4);
      sheet(s, THICKNESS.max, SWELL_MAX, -1, w);
      expect(Array.from(out)).toEqual(Array.from(w));
    }
  });
});

describe("tpmsClearance", () => {
  it("is a true lower bound on the distance to the worst-case sheet (vs brute force)", () => {
    for (const name of NAMES) {
      const s = TPMS[name];
      const k = TAU / s.period;
      const clear = tpmsClearance(s);
      const r = rng(9);
      /** @type {number[][]} */
      const probes = [];
      for (let i = 0; i < 40; i++) probes.push([r() * s.period, r() * s.period, r() * s.period]);
      // Along the net's edges, where the camera flies (the necks are where it's tightest).
      const nodes = s.nodes.map((n) => n.map((v) => (v * s.period) / 8));
      for (const a of nodes)
        for (let i = 0; i < 6; i++) {
          const d = [r() - 0.5, r() - 0.5, r() - 0.5].map((v) => v * s.period * 0.9);
          probes.push([a[0] + d[0], a[1] + d[1], a[2] + d[2]]);
          probes.push(a.map((v, c) => v + (s.period / 2) * (c === i % 3 ? 1 : 0) * (name === "schwarz-p" ? 1 : 0.3)));
        }
      let tested = 0;
      let slack = Infinity;
      for (const p of probes) {
        const c = clear(p);
        if (!(c > 0)) continue;
        tested++;
        // Every point on the sphere of radius c is on the camera's side of the worst-case sheet.
        let least = Infinity;
        for (let j = 0; j < 1500; j++) {
          const d = [r() - 0.5, r() - 0.5, r() - 0.5];
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          const f = s.f(k * (p[0] + (d[0] / l) * c), k * (p[1] + (d[1] / l) * c), k * (p[2] + (d[2] / l) * c));
          least = Math.min(least, f);
        }
        const u = new Float64Array(4);
        sheet(s, THICKNESS.max, SWELL_MAX, 1, u);
        expect(least, name).toBeGreaterThan(u[1] + u[2]);
        slack = Math.min(slack, least - u[1] - u[2]);
      }
      expect(tested, name).toBeGreaterThan(12);
      // ...and not uselessly loose somewhere: some probe's sphere comes close to the sheet.
      expect(slack, name).toBeLessThan(0.15);
    }
  });

  it("is generous where the free space is wide and negative on the walls", () => {
    for (const name of NAMES) {
      const s = TPMS[name];
      const clear = tpmsClearance(s);
      const node = s.nodes[0].map((v) => (v * s.period) / 8);
      expect(clear(node), name).toBeGreaterThan(0.4);
      // On the mid-sheet (f = 0), at any music.
      const p = wallPoint(s)(node, new Float64Array(3));
      expect(clear(p), name).toBeLessThan(0);
    }
  });
});

describe("wallPoint", () => {
  it("drops a point in the labyrinth onto the nearest wall's mid-sheet, nearby", () => {
    for (const name of NAMES) {
      const s = TPMS[name];
      const k = TAU / s.period;
      const snap = wallPoint(s);
      const r = rng(4);
      const out = new Float64Array(3);
      for (let i = 0; i < 100; i++) {
        const p = [r() * 20 - 10, r() * 20 - 10, r() * 20 - 10];
        snap(p, out);
        expect(Math.abs(s.f(k * out[0], k * out[1], k * out[2])), name).toBeLessThan(1e-4);
        // No farther than the farthest the free space reaches from a wall.
        expect(Math.hypot(out[0] - p[0], out[1] - p[1], out[2] - p[2]), name).toBeLessThan(0.45 * s.period);
      }
    }
  });
});

describe("createMorph", () => {
  /** @param {number} bassAtt @param {number} midAtt */
  const audio = (bassAtt, midAtt) => ({ bassAtt, midAtt });

  it("bass slowly thickens, mids shift the level either way, both eased and bounded", () => {
    const m = createMorph();
    expect(m.swell).toBe(0);
    expect(m.offset).toBe(0);
    let prevS = 0;
    let prevO = 0;
    let maxRateS = 0;
    let maxRateO = 0;
    for (let f = 0; f < 600; f++) {
      m.step(audio(2, 2), 1 / 60, 2, true, false);
      maxRateS = Math.max(maxRateS, Math.abs(m.swell - prevS) * 60);
      maxRateO = Math.max(maxRateO, Math.abs(m.offset - prevO) * 60);
      prevS = m.swell;
      prevO = m.offset;
      expect(m.swell).toBeLessThanOrEqual(SWELL_MAX);
      expect(m.offset).toBeLessThanOrEqual(1);
    }
    expect(m.swell).toBeGreaterThan(SWELL_MAX * 0.95);
    expect(m.offset).toBeGreaterThan(0.95);
    // Eased: no faster than a full swing in about a second (the first 100 ms barely moves).
    expect(maxRateS).toBeLessThan(SWELL_MAX * 1.6);
    expect(maxRateO).toBeLessThan(1.6);
    const n = createMorph();
    for (let f = 0; f < 6; f++) n.step(audio(2, 0), 1 / 60, 2, true, false);
    expect(n.swell).toBeLessThan(0.02 * SWELL_MAX);
    for (let f = 0; f < 600; f++) n.step(audio(2, 0), 1 / 60, 2, true, false);
    expect(n.offset).toBeLessThan(-0.95);
  });

  it("settles back in silence and at Reactivity 0, and is calmer under Reduce motion", () => {
    const m = createMorph();
    for (let f = 0; f < 600; f++) m.step(audio(2, 2), 1 / 60, 1, true, false);
    for (let f = 0; f < 900; f++) m.step(audio(2, 2), 1 / 60, 1, false, false);
    expect(m.swell).toBeLessThan(1e-3);
    expect(Math.abs(m.offset)).toBeLessThan(1e-3);
    for (let f = 0; f < 900; f++) m.step(audio(2, 2), 1 / 60, 0, true, false);
    expect(m.swell).toBeLessThan(1e-3);
    const r = createMorph();
    for (let f = 0; f < 900; f++) r.step(audio(2, 2), 1 / 60, 2, true, true);
    expect(r.swell).toBeLessThan(0.35 * SWELL_MAX);
    expect(r.offset).toBeLessThan(0.35);
  });

  it("is frame-rate independent", () => {
    const a = createMorph();
    const b = createMorph();
    for (let f = 0; f < 120; f++) a.step(audio(1.7, 1.4), 1 / 120, 1, true, false);
    for (let f = 0; f < 20; f++) b.step(audio(1.7, 1.4), 1 / 20, 1, true, false);
    expect(a.swell).toBeCloseTo(b.swell, 3);
    expect(a.offset).toBeCloseTo(b.offset, 3);
  });
});
