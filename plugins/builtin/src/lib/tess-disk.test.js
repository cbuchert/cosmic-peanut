// @ts-check
import { describe, expect, it } from "vitest";
import { mobiusApply, mobiusCompose } from "./hyperbolic.js";
import { createDiskTiler, createTile, diskGeometry, diskGroup, matIndex, matMul, TILINGS, tilingPQ } from "./tess-disk.js";

/** Small seeded PRNG for repeatable random points. @param {number} seed */
function rng(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three mirrors as disk isometries (lib/hyperbolic.js form). @param {{ alpha: number, cx: number, r: number }} t */
function mirrors(t) {
  const ca = Math.cos(t.alpha);
  const sa = Math.sin(t.alpha);
  return [
    Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 1]), // a: z ↦ z̄
    Float64Array.from([ca, sa, 0, 0, 0, 0, ca, -sa, 1]), // b: z ↦ e^{2iα} z̄
    mobiusCompose(new Float64Array(9), Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0]), Float64Array.from([t.cx, 0, t.r * t.r - t.cx * t.cx, 0, 1, 0, -t.cx, 0, 1])), // c: inversion in C
  ];
}

describe("tiling param", () => {
  it("maps the Tiling options to {p,q}; unknown → {7,3}", () => {
    expect(TILINGS).toEqual(["{7,3}", "{5,4}", "{4,5}", "{6,4}"]);
    expect(tilingPQ("{7,3}")).toEqual([7, 3]);
    expect(tilingPQ("{5,4}")).toEqual([5, 4]);
    expect(tilingPQ("{4,5}")).toEqual([4, 5]);
    expect(tilingPQ("{6,4}")).toEqual([6, 4]);
    expect(tilingPQ("nope")).toEqual([7, 3]);
  });
});

describe.each(TILINGS)("finite quotient of the %s triangle group", (name) => {
  const g = diskGroup(name);
  const [p, q] = tilingPQ(name);
  const t = new Int32Array(4);
  const u = new Int32Array(4);
  /** Order of a matrix in PGL(2, r) (smallest n with mⁿ scalar). @param {ArrayLike<number>} m */
  const order = (m) => {
    t.set(m);
    for (let n = 1; n < 200; n++) {
      if (t[1] === 0 && t[2] === 0 && t[0] === t[3]) return n;
      matMul(g.r, t, m, u);
      t.set(u);
    }
    return -1;
  };
  const mul = (/** @type {ArrayLike<number>[]} */ ...ms) => {
    const out = new Int32Array([1, 0, 0, 1]);
    for (const m of ms) out.set(matMul(g.r, out, m, new Int32Array(4)));
    return out;
  };

  it("represents the mirrors a, b, c (angles π/p at the centre, π/2 at the edge, π/q at the vertex)", () => {
    expect(g.p).toBe(p);
    expect(g.q).toBe(q);
    expect([order(g.A), order(g.B), order(g.C)]).toEqual([2, 2, 2]);
    expect(order(mul(g.A, g.B))).toBe(p);
    expect(order(mul(g.B, g.C))).toBe(q);
    expect(order(mul(g.A, g.C))).toBe(2);
    // ρ^k = (BA)^k, the turns about the tile centre the fold uses.
    for (let k = 0; k < p; k++) {
      let e = new Int32Array([1, 0, 0, 1]);
      for (let i = 0; i < k; i++) e = mul(e, g.B, g.A);
      expect(matIndex(g.r, g.rho.subarray(4 * k, 4 * k + 4))).toBe(matIndex(g.r, e));
    }
  });

  it("3-colours the kites: no two that share an edge (across ρ±1 or τ±1) have the same colour", () => {
    expect(g.classes).toBe(3);
    const rho = mul(g.B, g.A);
    const rhoI = mul(g.A, g.B);
    const tau = mul(g.C, g.B);
    const tauI = mul(g.B, g.C);
    const counts = [0, 0, 0];
    expect(g.kites.length).toBeGreaterThan(50);
    for (const f of g.kites) {
      const c = g.classOf(f);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(3);
      counts[c]++;
      for (const s of [rho, rhoI, tau, tauI]) expect(g.classOf(mul(f, s))).not.toBe(c);
    }
    // All three used, none starved.
    for (const n of counts) expect(n).toBeGreaterThan(g.kites.length / 5);
  });

  it("tabulates, for every scalar multiple of each kite's matrix, the colours of the four kites round its edge midpoint", () => {
    const r = g.r;
    expect(g.table.length).toBe(r ** 4 * 4);
    const rhoI = mul(g.A, g.B);
    const tau = mul(g.C, g.B);
    const mu = mul(g.A, g.C);
    for (const f of g.kites) {
      const want = [g.classOf(f), g.classOf(mul(f, rhoI)), g.classOf(mul(f, tau)), g.classOf(mul(f, mu))];
      for (let k = 1; k < r; k++) {
        const i = matIndex(r, Array.from(f, (v) => (v * k) % r)) * 4;
        expect(Array.from(g.table.subarray(i, i + 4))).toEqual(want);
      }
    }
  });
});

describe.each(TILINGS)("kite geometry of %s", (name) => {
  const geo = diskGeometry(name);
  /** uv of chart-square point (s, t) through quadrant q's homography. */
  const uvOf = (/** @type {number} */ q, /** @type {number} */ s, /** @type {number} */ t) => {
    const h = geo.H.subarray(9 * q, 9 * q + 9); // column-major mat3
    const w = h[2] * s + h[5] * t + h[8];
    return [(h[0] * s + h[3] * t + h[6]) / w, (h[1] * s + h[4] * t + h[7]) / w];
  };
  const close = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  };

  it("maps the kite's corners O, M, V to uv (0,0), (1,0), (1,1), as the engine's p4 tile", () => {
    // Chart square: O = (−1, −1), M = (0, 0), V = (1, −1); quadrant 0 holds T.
    close(uvOf(0, -1, -1), [0, 0]);
    close(uvOf(0, 0, 0), [1, 0]);
    close(uvOf(0, 1, -1), [1, 1]);
    expect(geo.kiteArea).toBeCloseTo(2 * Math.PI * (0.5 - 1 / geo.p - 1 / geo.q), 12);
  });

  it("agrees across each edge of the cross: the two kites see the same edge point", () => {
    for (let i = 1; i < 10; i++) {
      const a = -i / 10; // O–M (s = t < 0): u along one kite's v = 0 edge, v along the other's u = 0 edge
      const ua = uvOf(0, a, a);
      const ub = uvOf(1, a, a);
      expect(ua[1]).toBeCloseTo(0, 6);
      expect(ub[0]).toBeCloseTo(0, 6);
      expect(ub[1]).toBeCloseTo(ua[0], 6);
      const b = i / 10; // M–V (s = −t > 0): u = 1 on one side, v = 1 on the other
      const uc = uvOf(0, b, -b);
      const ud = uvOf(2, b, -b);
      expect(uc[0]).toBeCloseTo(1, 6);
      expect(ud[1]).toBeCloseTo(1, 6);
      expect(ud[0]).toBeCloseTo(uc[1], 6);
    }
  });
});

describe.each(TILINGS)("the %s tiling in the plane (mirror of disk.frag)", (name) => {
  const geo = diskGeometry(name);
  const tiler = createDiskTiler(name);
  const [ma, mb, mc] = mirrors(geo.tiling);
  const a = createTile();
  const b = createTile();
  const z = new Float64Array(2);

  /** A random element of the rotation subgroup: a word of 2…8 mirrors. @param {() => number} r */
  function evenWord(r) {
    const g = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0]);
    const n = 2 * (1 + Math.floor(r() * 4));
    for (let i = 0; i < n; i++) mobiusCompose(g, [ma, mb, mc][Math.floor(r() * 3)], g);
    return g;
  }

  it("every point lands in one kite with a colour class and uv inside the kite", () => {
    const r = rng(3);
    for (let i = 0; i < 2000; i++) {
      const rad = 0.95 * Math.sqrt(r());
      const ang = r() * 2 * Math.PI;
      tiler.tileAt(rad * Math.cos(ang), rad * Math.sin(ang), null, a);
      expect([0, 1, 2]).toContain(a.cls);
      expect(a.u).toBeGreaterThan(-1e-6);
      expect(a.u).toBeLessThan(1 + 1e-6);
      expect(a.v).toBeGreaterThan(-1e-6);
      expect(a.v).toBeLessThan(1 + 1e-6);
    }
  });

  it("kites are congruent: a rotation of the tiling maps each point's uv to the same uv", () => {
    const r = rng(5);
    let n = 0;
    while (n < 300) {
      const g = evenWord(r);
      const rad = 0.7 * Math.sqrt(r());
      const ang = r() * 2 * Math.PI;
      const x = rad * Math.cos(ang);
      const y = rad * Math.sin(ang);
      mobiusApply(g, x, y, z);
      if (Math.hypot(z[0], z[1]) > 0.9) continue;
      tiler.tileAt(x, y, null, a);
      tiler.tileAt(z[0], z[1], null, b);
      if (Math.min(a.u, a.v, 1 - a.u, 1 - a.v) < 1e-4) continue; // on an edge: either side is fine
      expect(b.u).toBeCloseTo(a.u, 4);
      expect(b.v).toBeCloseTo(a.v, 4);
      n++;
    }
  });

  it("the colouring is proper: across every kite edge the colour changes", () => {
    const r = rng(9);
    let crossings = 0;
    for (let i = 0; i < 3000; i++) {
      const rad = 0.85 * Math.sqrt(r());
      const ang = r() * 2 * Math.PI;
      const x0 = rad * Math.cos(ang);
      const y0 = rad * Math.sin(ang);
      const d = r() * 2 * Math.PI;
      let lo = 0;
      let hi = 0.08;
      tiler.tileAt(x0, y0, null, a);
      const k0 = a.kite;
      tiler.tileAt(x0 + hi * Math.cos(d), y0 + hi * Math.sin(d), null, b);
      if (b.kite === k0) continue;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        tiler.tileAt(x0 + mid * Math.cos(d), y0 + mid * Math.sin(d), null, b);
        if (b.kite === k0) lo = mid;
        else hi = mid;
      }
      tiler.tileAt(x0 + lo * Math.cos(d), y0 + lo * Math.sin(d), null, a);
      tiler.tileAt(x0 + hi * Math.cos(d), y0 + hi * Math.sin(d), null, b);
      if (a.kite === b.kite) continue;
      expect(b.cls).not.toBe(a.cls);
      crossings++;
    }
    expect(crossings).toBeGreaterThan(500);
  });
});
