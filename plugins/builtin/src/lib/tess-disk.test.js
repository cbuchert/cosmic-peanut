// @ts-check
import { describe, expect, it } from "vitest";
import { mobiusApply, mobiusCompose } from "./hyperbolic.js";
import { WARP_LIMIT } from "./tess.js";
import {
  createDiskTiler,
  createDiskView,
  createDiskWarp,
  DISK_DRIFT,
  createTile,
  DISK_MODES,
  DISK_STEPS,
  diskBound,
  diskFieldAt,
  diskGeometry,
  diskGroup,
  diskWarp,
  matIndex,
  matMul,
  TILINGS,
  tilingPQ,
} from "./tess-disk.js";

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

describe("the creature warp (a field in the diamond round each edge midpoint)", () => {
  const out = [0, 0];
  const out2 = [0, 0];
  const FAMS = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
    [0.4, 0.1, 0.2, 0.3],
  ];

  it("uses only modes that are odd under the half-turn about the edge midpoint", () => {
    expect(DISK_MODES.length).toBeGreaterThanOrEqual(6);
    for (const [n, m] of DISK_MODES) expect((n + m) % 2).toBe(1);
    expect(DISK_STEPS).toBeGreaterThanOrEqual(3);
  });

  it("commutes with the half-turn: d(−s, −t) = −d(s, t)", () => {
    const r = rng(21);
    const amps = Float32Array.from({ length: DISK_MODES.length * 2 }, () => r() - 0.5);
    for (let i = 0; i < 200; i++) {
      const s = 2 * r() - 1;
      const t = 2 * r() - 1;
      diskFieldAt(amps, s, t, out);
      diskFieldAt(amps, -s, -t, out2);
      expect(Math.hypot(out[0], out[1])).toBeGreaterThan(0);
      expect(out2[0]).toBeCloseTo(-out[0], 9);
      expect(out2[1]).toBeCloseTo(-out[1], 9);
    }
  });

  it("is still (value and slope) on the diamond's edges, so the warp is smooth across them", () => {
    const amps = Float32Array.from({ length: DISK_MODES.length * 2 }, (_, i) => Math.sin(i + 1));
    const h = 1e-4;
    for (let i = 0; i <= 20; i++) {
      const a = -1 + i / 10;
      for (const [s, t] of [[a, 1], [a, -1], [1, a], [-1, a]]) {
        diskFieldAt(amps, s, t, out);
        expect(Math.hypot(out[0], out[1])).toBeLessThan(1e-9);
        // One step in, the field is second order: tiny.
        diskFieldAt(amps, s - Math.sign(s) * h * (Math.abs(s) === 1 ? 1 : 0), t - Math.sign(t) * h * (Math.abs(t) === 1 ? 1 : 0), out);
        expect(Math.hypot(out[0], out[1])).toBeLessThan(1e-5);
      }
    }
  });

  it("bounds each mode's slope from above (the bound is honest)", () => {
    for (let j = 0; j < DISK_MODES.length; j++) {
      const amps = new Float32Array(DISK_MODES.length * 2);
      amps[2 * j] = 1;
      const bound = diskBound(amps);
      let worst = 0;
      const h = 1e-5;
      for (let i = 0; i <= 200; i++) {
        for (let k = 0; k <= 200; k++) {
          const s = -1 + i / 100;
          const t = -1 + k / 100;
          diskFieldAt(amps, s, t, out);
          diskFieldAt(amps, s + h, t, out2);
          const gs = (out2[0] - out[0]) / h;
          diskFieldAt(amps, s, t + h, out2);
          const gt = (out2[0] - out[0]) / h;
          worst = Math.max(worst, Math.hypot(gs, gt));
        }
      }
      expect(worst).toBeLessThanOrEqual(bound);
      expect(worst).toBeGreaterThan(0.9 * bound);
    }
  });

  it.each(FAMS)("fits each step under the invertibility bound (weights %s), at any turn", (...w) => {
    const warp = createDiskWarp();
    for (const theta of [0, 0.3, -0.35]) {
      warp.set(w, theta);
      expect(diskBound(warp.amps)).toBeCloseTo(WARP_LIMIT, 4);
      // The analytic bound holds numerically: largest |J| of one step on a fine grid.
      let worst = 0;
      const h = 1e-4;
      for (let i = 0; i <= 60; i++) {
        for (let j = 0; j <= 60; j++) {
          const s = -1 + (2 * i) / 60;
          const t = -1 + (2 * j) / 60;
          diskFieldAt(warp.amps, s, t, out);
          diskFieldAt(warp.amps, s + h, t, out2);
          const a = (out2[0] - out[0]) / h;
          const c = (out2[1] - out[1]) / h;
          diskFieldAt(warp.amps, s, t + h, out2);
          const b = (out2[0] - out[0]) / h;
          const d = (out2[1] - out[1]) / h;
          // Operator 2-norm of [[a, b], [c, d]].
          const f = a * a + b * b + c * c + d * d;
          const g = Math.sqrt(Math.max(0, f * f - 4 * (a * d - b * c) ** 2));
          worst = Math.max(worst, Math.sqrt((f + g) / 2));
        }
      }
      expect(worst).toBeLessThanOrEqual(WARP_LIMIT + 1e-3);
      expect(worst).toBeGreaterThan(0.2); // and it really deforms
    }
  });

  it("composes into a warp that moves the edges a good way but keeps the diamond's rim fixed", () => {
    const warp = createDiskWarp().set([0, 0, 0, 1], 0.2);
    let most = 0;
    for (let i = 1; i < 40; i++) {
      const a = -1 + i / 20;
      diskWarp(warp.amps, a, a, out);
      most = Math.max(most, Math.hypot(out[0] - a, out[1] - a));
      diskWarp(warp.amps, a, 1, out);
      expect(out[0]).toBeCloseTo(a, 9);
      expect(out[1]).toBeCloseTo(1, 9);
    }
    expect(most).toBeGreaterThan(0.08);
  });

  it("set() refills the same array; strength 0 is the bare kites; families differ", () => {
    const warp = createDiskWarp();
    const amps = warp.amps;
    expect(warp.set([1, 0, 0, 0], 0).amps).toBe(amps);
    const lobed = Array.from(amps);
    warp.set([0, 0, 0, 1], 0);
    expect(Array.from(amps)).not.toEqual(lobed);
    warp.set([1, 0, 0, 0], 0, 0);
    expect(Array.from(amps).every((v) => v === 0)).toBe(true);
  });
});

describe.each(TILINGS)("the warped %s tiling", (name) => {
  const geo = diskGeometry(name);
  const tiler = createDiskTiler(name);
  const [ma, mb, mc] = mirrors(geo.tiling);
  const amps = createDiskWarp().set([0.2, 0.2, 0.2, 0.4], 0.25).amps;
  const a = createTile();
  const b = createTile();
  const z = new Float64Array(2);

  it("is still congruent under the rotation group (the warp respects the symmetry)", () => {
    const r = rng(13);
    let n = 0;
    let moved = 0;
    const c = createTile();
    while (n < 300) {
      const g = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0]);
      const len = 2 * (1 + Math.floor(r() * 4));
      for (let i = 0; i < len; i++) mobiusCompose(g, [ma, mb, mc][Math.floor(r() * 3)], g);
      const rad = 0.7 * Math.sqrt(r());
      const ang = r() * 2 * Math.PI;
      const x = rad * Math.cos(ang);
      const y = rad * Math.sin(ang);
      mobiusApply(g, x, y, z);
      if (Math.hypot(z[0], z[1]) > 0.9) continue;
      tiler.tileAt(x, y, amps, a);
      tiler.tileAt(z[0], z[1], amps, b);
      if (Math.min(a.u, a.v, 1 - a.u, 1 - a.v) < 1e-4) continue;
      expect(b.u).toBeCloseTo(a.u, 4);
      expect(b.v).toBeCloseTo(a.v, 4);
      tiler.tileAt(x, y, null, c);
      if (Math.hypot(c.u - a.u, c.v - a.v) > 0.01) moved++;
      n++;
    }
    expect(moved).toBeGreaterThan(100); // the warp did change the kites
  });

  it("is still properly coloured across every (now curved) edge", () => {
    const r = rng(17);
    let crossings = 0;
    for (let i = 0; i < 3000; i++) {
      const rad = 0.85 * Math.sqrt(r());
      const ang = r() * 2 * Math.PI;
      const x0 = rad * Math.cos(ang);
      const y0 = rad * Math.sin(ang);
      const d = r() * 2 * Math.PI;
      let lo = 0;
      let hi = 0.08;
      tiler.tileAt(x0, y0, amps, a);
      const k0 = a.kite;
      tiler.tileAt(x0 + hi * Math.cos(d), y0 + hi * Math.sin(d), amps, b);
      if (b.kite === k0) continue;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        tiler.tileAt(x0 + mid * Math.cos(d), y0 + mid * Math.sin(d), amps, b);
        if (b.kite === k0) lo = mid;
        else hi = mid;
      }
      tiler.tileAt(x0 + lo * Math.cos(d), y0 + lo * Math.sin(d), amps, a);
      tiler.tileAt(x0 + hi * Math.cos(d), y0 + hi * Math.sin(d), amps, b);
      if (a.kite === b.kite) continue;
      expect(b.cls).not.toBe(a.cls);
      // Both sides of an edge sit on the edge of their kite's uv square.
      expect(Math.min(a.u, a.v, 1 - a.u, 1 - a.v)).toBeLessThan(1e-3);
      expect(Math.min(b.u, b.v, 1 - b.u, 1 - b.v)).toBeLessThan(1e-3);
      crossings++;
    }
    expect(crossings).toBeGreaterThan(500);
  });
});

describe("the view: drift through the plane, drag to steer", () => {
  const tiler = createDiskTiler("{7,3}");
  const a = createTile();
  const b = createTile();
  const z = new Float64Array(2);
  /** uv of the kite under screen-disk point (x, y) through the view. */
  /** @param {{ m: Float64Array, e0: Int32Array }} v */
  const snap = (v) => ({ m: Float64Array.from(v.m), e0: Int32Array.from(v.e0) });
  const seen = (/** @type {{ m: Float64Array, e0: Int32Array }} */ v, /** @type {number} */ x, /** @type {number} */ y, /** @type {ReturnType<typeof createTile>} */ out) => {
    mobiusApply(v.m, x, y, z);
    return tiler.tileAt(z[0], z[1], null, out, v.e0);
  };
  const DT = 1 / 60;

  it("travels DISK_DRIFT hyperbolic units per unit of glide travel, along its flow", () => {
    const view = createDiskView("{7,3}");
    view.step(2.7, DT, 300, false); // off the kite corner at the start
    for (let i = 0; i < 5; i++) {
      const before = snap(view);
      view.step(0.5, DT, 300, false);
      // What was at the centre now sits DISK_DRIFT × 0.5 away along the flow.
      const r = Math.tanh((DISK_DRIFT * 0.5) / 2);
      seen(before, 0, 0, a);
      seen(view, r * Math.cos(view.flow), r * Math.sin(view.flow), b);
      expect(b.kite).toBe(a.kite);
      expect(b.cls).toBe(a.cls);
      expect(b.u).toBeCloseTo(a.u, 6);
      expect(b.v).toBeCloseTo(a.v, 6);
    }
    expect(DISK_DRIFT).toBeGreaterThan(0.05);
  });

  it("stays precise however far it goes (rebased by rotations of the tiling only)", () => {
    const view = createDiskView("{5,4}");
    for (let i = 0; i < 20000; i++) {
      view.step(0.05, DT, 300, false);
      expect(view.m[8]).toBe(0); // never mirrored
    }
    expect(Math.hypot(view.centre[0], view.centre[1])).toBeLessThan(0.8);
    for (let i = 0; i < 8; i++) expect(Math.abs(view.m[i])).toBeLessThan(5);
    // Still an isometry: distances from the centre are kept.
    const p = new Float64Array(2);
    const o = new Float64Array(2);
    mobiusApply(view.m, 0, 0, o);
    mobiusApply(view.m, 0.5, 0, p);
    const d = Math.hypot(p[0] - o[0], p[1] - o[1]) / Math.hypot(1 - (o[0] * p[0] + o[1] * p[1]), o[0] * p[1] - o[1] * p[0]);
    expect(d).toBeCloseTo(0.5, 9);
  });

  it("a drag carries the plane with the pointer", () => {
    const view = createDiskView("{7,3}");
    view.step(2.7, DT, 300, false);
    const before = snap(view);
    view.pointer({ kind: "down", dx: 0, dy: 0 });
    view.pointer({ kind: "move", dx: 24, dy: -12 }); // CSS px: right and up
    view.step(0, DT, 300, false);
    seen(before, 0, 0, a);
    seen(view, 24 / 300, 12 / 300, b);
    expect(b.kite).toBe(a.kite);
    expect(b.u).toBeCloseTo(a.u, 6);
    expect(b.v).toBeCloseTo(a.v, 6);
  });

  it("steers the drift: after a drag the plane keeps flowing the way it was dragged, easing round", () => {
    const view = createDiskView("{7,3}");
    for (let i = 0; i < 60; i++) view.step(0.02, DT, 300, false);
    view.pointer({ kind: "down", dx: 0, dy: 0 });
    view.pointer({ kind: "move", dx: -30, dy: 0 }); // to the left
    view.pointer({ kind: "up", dx: 0, dy: 0 });
    let last = view.flow;
    let jump = 0;
    for (let i = 0; i < 120; i++) {
      view.step(0.02, DT, 300, false);
      jump = Math.max(jump, Math.abs(Math.atan2(Math.sin(view.flow - last), Math.cos(view.flow - last))));
      last = view.flow;
    }
    expect(Math.cos(view.flow)).toBeLessThan(-0.95);
    expect(jump).toBeLessThan(0.15); // eased, never a snap
    // Moves after the release don't drag.
    const before = snap(view);
    view.pointer({ kind: "move", dx: 50, dy: 50 });
    view.step(0, DT, 300, false);
    for (let i = 0; i < 8; i++) expect(view.m[i]).toBeCloseTo(before.m[i], 9);
  });

  it("switches tiling in place", () => {
    const view = createDiskView("{7,3}");
    const m = view.m;
    view.setTiling("{4,5}");
    view.step(0.1, DT, 300, false);
    expect(view.m).toBe(m);
    expect(Math.hypot(view.centre[0], view.centre[1])).toBeLessThan(0.8);
  });
});
