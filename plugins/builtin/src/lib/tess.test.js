// @ts-check
import { describe, expect, it } from "vitest";
import {
  blendBound,
  blendGradient,
  classColor,
  createTile,
  createWarp,
  FAMILIES,
  MAX_TILE_COLORS,
  PALETTES,
  paletteOf,
  cardHeight,
  CARD_HALF,
  drosteAlpha,
  drosteAt,
  expandAmps,
  fieldAt,
  fitWarp,
  groupOf,
  RELIEF_BEVEL,
  RELIEF_BLOCK,
  RELIEF_DOME,
  reliefBound,
  reliefHeight,
  reliefProfile,
  reliefSlope,
  tileAt,
  WARP_LIMIT,
  warpAt,
} from "./tess.js";

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

/** @param {number} a @param {number[]} v */
const rot = (a, [x, y]) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];

/** Random base amplitudes for every base term of a group. @param {ReturnType<typeof groupOf>} g */
function randomAmps(g, /** @type {number} */ seed) {
  const r = rng(seed);
  const a = new Float32Array(g.terms.length * 2);
  for (let i = 0; i < a.length; i++) a[i] = (r() - 0.5) * 0.02;
  return a;
}

describe.each(["p4", "p3"])("symmetrized warp, %s", (name) => {
  const g = groupOf(name);
  const amps = expandAmps(g, randomAmps(g, 7), 0.3, new Float32Array(g.n * 2));
  const out = [0, 0];
  const out2 = [0, 0];

  it("commutes with the group's rotation about the origin", () => {
    const r = rng(11);
    for (let i = 0; i < 50; i++) {
      const p = [(r() - 0.5) * 6, (r() - 0.5) * 6];
      warpAt(g, amps, p[0], p[1], out);
      const rp = rot((2 * Math.PI) / g.order, p);
      warpAt(g, amps, rp[0], rp[1], out2);
      const rd = rot((2 * Math.PI) / g.order, out);
      expect(out2[0]).toBeCloseTo(rd[0], 6);
      expect(out2[1]).toBeCloseTo(rd[1], 6);
    }
  });

  it("is periodic on the lattice", () => {
    const r = rng(13);
    for (let i = 0; i < 50; i++) {
      const p = [(r() - 0.5) * 6, (r() - 0.5) * 6];
      warpAt(g, amps, p[0], p[1], out);
      for (const e of g.basis) {
        warpAt(g, amps, p[0] + e[0], p[1] + e[1], out2);
        expect(out2[0]).toBeCloseTo(out[0], 6);
        expect(out2[1]).toBeCloseTo(out[1], 6);
      }
    }
  });

  it("is not trivially zero", () => {
    warpAt(g, amps, 0.13, 0.21, out);
    expect(Math.hypot(out[0], out[1])).toBeGreaterThan(1e-4);
  });
});

describe.each(["p4", "p3"])("invertibility bound, %s", (name) => {
  const g = groupOf(name);
  // Two sets interleaved (A.xy, B.xy per term), deliberately far too strong before fitting.
  const ab = new Float32Array(g.n * 4);
  const big = randomAmps(g, 3).map((v) => v * 40);
  expandAmps(g, big, 0.2, ab, 4, 0);
  expandAmps(g, randomAmps(g, 5).map((v) => v * 40), -0.7, ab, 4, 2);
  /** The spatial blend between the sets: m(p) = ½ + ½ sin(2π km·p + φ). */
  const blend = { kx: 1 / 6, ky: 1 / 12, phase: 0.4 };

  it("fitting scales both sets under the limit, and the limit is below 1", () => {
    expect(blendBound(g, ab, blendGradient(blend))).toBeGreaterThan(1);
    fitWarp(g, ab, blendGradient(blend), WARP_LIMIT);
    expect(blendBound(g, ab, blendGradient(blend))).toBeLessThanOrEqual(WARP_LIMIT + 1e-9);
    expect(WARP_LIMIT).toBeLessThan(1);
  });

  it("bounds the blended field's Jacobian, so p + d(p) stays orientation-preserving", () => {
    fitWarp(g, ab, blendGradient(blend), WARP_LIMIT);
    const bound = blendBound(g, ab, blendGradient(blend));
    const r = rng(17);
    const a = [0, 0];
    const b = [0, 0];
    const h = 1e-4;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = (r() - 0.5) * 12;
      const y = (r() - 0.5) * 12;
      fieldAt(g, ab, blend, x + h, y, a);
      fieldAt(g, ab, blend, x - h, y, b);
      const j00 = (a[0] - b[0]) / (2 * h);
      const j10 = (a[1] - b[1]) / (2 * h);
      fieldAt(g, ab, blend, x, y + h, a);
      fieldAt(g, ab, blend, x, y - h, b);
      const j01 = (a[0] - b[0]) / (2 * h);
      const j11 = (a[1] - b[1]) / (2 * h);
      // Spectral norm of the 2×2 Jacobian.
      const s1 = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11;
      const det = j00 * j11 - j01 * j10;
      const norm = Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2);
      worst = Math.max(worst, norm);
      expect((1 + j00) * (1 + j11) - j01 * j10).toBeGreaterThan(0);
    }
    expect(worst).toBeLessThanOrEqual(bound + 1e-6);
    // The fit isn't wastefully tight either: the field uses a fair share of the allowance.
    expect(worst).toBeGreaterThan(0.25 * bound);
  });

  it("is injective: distinct sample points never land on the same warped point", () => {
    fitWarp(g, ab, blendGradient(blend), WARP_LIMIT);
    const r = rng(23);
    const a = [0, 0];
    const b = [0, 0];
    for (let i = 0; i < 400; i++) {
      const x = (r() - 0.5) * 8;
      const y = (r() - 0.5) * 8;
      const x2 = x + (r() - 0.5) * 0.2;
      const y2 = y + (r() - 0.5) * 0.2;
      fieldAt(g, ab, blend, x, y, a);
      fieldAt(g, ab, blend, x2, y2, b);
      const dist = Math.hypot(x2 - x, y2 - y);
      const wd = Math.hypot(x2 + b[0] - x - a[0], y2 + b[1] - y - a[1]);
      // Lipschitz < L ⇒ |W(p) − W(p')| ≥ (1 − L)|p − p'|.
      expect(wd).toBeGreaterThanOrEqual((1 - WARP_LIMIT) * dist - 1e-9);
    }
  });
});

describe.each([
  ["p4", 2],
  ["p3", 3],
])("tiles and colouring, %s", (name, classes) => {
  const g = groupOf(name);
  const t = createTile();
  const t2 = createTile();

  it("gives every point a tile with a class, an orientation and local coordinates in the unit square", () => {
    const r = rng(29);
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      tileAt(g, (r() - 0.5) * 10, (r() - 0.5) * 10, t);
      seen.add(t.cls);
      expect(t.orient).toBeGreaterThanOrEqual(0);
      expect(t.orient).toBeLessThan(g.order);
      expect(t.u).toBeGreaterThanOrEqual(-1e-9);
      expect(t.u).toBeLessThanOrEqual(1 + 1e-9);
      expect(t.v).toBeGreaterThanOrEqual(-1e-9);
      expect(t.v).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect([...seen].sort()).toEqual([...Array(classes).keys()]);
  });

  it("local frames rotate with the tile: rotating the point keeps its local coordinates", () => {
    const r = rng(31);
    for (let i = 0; i < 200; i++) {
      const p = [(r() - 0.5) * 6, (r() - 0.5) * 6];
      tileAt(g, p[0], p[1], t);
      const q = rot((2 * Math.PI) / g.order, p);
      tileAt(g, q[0], q[1], t2);
      expect(t2.u).toBeCloseTo(t.u, 6);
      expect(t2.v).toBeCloseTo(t.v, 6);
      expect(t2.orient).toBe((t.orient + 1) % g.order);
    }
  });

  it("estimates the distance to the tile's boundary", () => {
    const r = rng(37);
    for (let i = 0; i < 200; i++) {
      const x = (r() - 0.5) * 6;
      const y = (r() - 0.5) * 6;
      tileAt(g, x, y, t);
      const id = t.id;
      const d = t.dist;
      expect(d).toBeGreaterThanOrEqual(0);
      // Nothing within 0.98 d is another tile; something at 1.02 d is (along the gradient, outward).
      for (let a = 0; a < 24; a++) {
        const c = Math.cos((a / 24) * 2 * Math.PI);
        const s = Math.sin((a / 24) * 2 * Math.PI);
        tileAt(g, x + c * d * 0.98, y + s * d * 0.98, t2);
        expect(t2.id).toBe(id);
      }
      tileAt(g, x - t.nx * (d * 1.02 + 1e-6), y - t.ny * (d * 1.02 + 1e-6), t2);
      expect(t2.id).not.toBe(id);
    }
  });

  it("neighbouring tiles never share a class, nor a colour under any figure/ground shift", () => {
    const r = rng(41);
    let crossings = 0;
    for (let i = 0; i < 2000; i++) {
      const x = (r() - 0.5) * 8;
      const y = (r() - 0.5) * 8;
      tileAt(g, x, y, t);
      // Step just across the nearest edge: lands in the tile sharing that edge.
      tileAt(g, x - t.nx * (t.dist + 1e-6), y - t.ny * (t.dist + 1e-6), t2);
      expect(t2.id).not.toBe(t.id);
      crossings++;
      expect(t2.cls).not.toBe(t.cls);
      for (const n of [3, 4, 5]) {
        for (let shift = 0; shift < 2 * n; shift++) {
          expect(classColor(t.cls, shift, n)).not.toBe(classColor(t2.cls, shift, n));
        }
      }
    }
    expect(crossings).toBeGreaterThan(200);
  });
});

describe.each(["p4", "p3"])("Droste map, %s", (name) => {
  const g = groupOf(name);
  const alpha = [0, 0];

  it("one turn around the centre is a lattice translation", () => {
    drosteAlpha(g, 5, 2, alpha);
    // α · 2πi = 5 e1 + 2 e2
    const vx = -alpha[1] * 2 * Math.PI;
    const vy = alpha[0] * 2 * Math.PI;
    expect(vx).toBeCloseTo(5 * g.basis[0][0] + 2 * g.basis[1][0], 9);
    expect(vy).toBeCloseTo(5 * g.basis[0][1] + 2 * g.basis[1][1], 9);
  });

  it("the tiling lines up across the log-polar seam", () => {
    drosteAlpha(g, 5, 2, alpha);
    const a = createTile();
    const b = createTile();
    const pa = [0, 0];
    const pb = [0, 0];
    const fa = [0, 0];
    const fb = [0, 0];
    const amps = expandAmps(g, randomAmps(g, 43), 0.5, new Float32Array(g.n * 2));
    const r = rng(47);
    for (let i = 0; i < 200; i++) {
      const rad = 0.05 + r() * 0.9;
      const eps = 1e-7;
      // Just above and just below the negative real axis, where atan2 wraps.
      drosteAt(alpha, -rad, eps, pa);
      drosteAt(alpha, -rad, -eps, pb);
      expect(Math.abs(pa[1] - pb[1]) + Math.abs(pa[0] - pb[0])).toBeGreaterThan(1); // a real jump…
      tileAt(g, pa[0], pa[1], a);
      tileAt(g, pb[0], pb[1], b);
      if (a.dist < 1e-4) continue; // on a tile edge the two sides may round apart
      expect(b.cls).toBe(a.cls); // …that lands on the same spot of the same kind of tile
      expect(b.u).toBeCloseTo(a.u, 4);
      expect(b.v).toBeCloseTo(a.v, 4);
      warpAt(g, amps, pa[0], pa[1], fa);
      warpAt(g, amps, pb[0], pb[1], fb);
      expect(fb[0]).toBeCloseTo(fa[0], 4);
      expect(fb[1]).toBeCloseTo(fa[1], 4);
    }
  });
});

describe.each(["p4", "p3"])("motif families and the warp builder, %s", (name) => {
  const g = groupOf(name);
  const blend = { kx: 1 / 8, ky: 0, phase: 0 };

  it("has the four original motif families, dark to bright", () => {
    expect(FAMILIES).toEqual(["lobed", "finned", "star", "hooked"]);
  });

  it("fills both sets from family weights and keeps them under the bound", () => {
    const w = createWarp(g);
    const one = (/** @type {number} */ f) => FAMILIES.map((_, i) => (i === f ? 1 : 0));
    for (let f = 0; f < FAMILIES.length; f++) {
      w.set(one(f), 0, one((f + 2) % 4), 1, blend);
      expect(blendBound(g, w.ab, blendGradient(blend))).toBeLessThanOrEqual(WARP_LIMIT + 1e-9);
      // A single family alone uses the whole allowance (each preset is normalized to it).
      expect(blendBound(g, w.ab, blendGradient(blend))).toBeGreaterThan(0.95 * WARP_LIMIT);
    }
  });

  it("different families give different fields; equal weights give equal sets", () => {
    const w = createWarp(g);
    /** @type {number[][]} */
    const out = [];
    for (let f = 0; f < FAMILIES.length; f++) {
      const wt = FAMILIES.map((_, i) => (i === f ? 1 : 0));
      w.set(wt, 0, wt, 0, blend);
      out.push(Array.from(w.ab));
      for (let i = 0; i < g.n; i++) {
        expect(w.ab[i * 4 + 2]).toBeCloseTo(w.ab[i * 4], 9);
        expect(w.ab[i * 4 + 3]).toBeCloseTo(w.ab[i * 4 + 1], 9);
      }
    }
    for (let a = 0; a < out.length; a++)
      for (let b = a + 1; b < out.length; b++) {
        const diff = out[a].reduce((s, v, i) => s + Math.abs(v - out[b][i]), 0);
        expect(diff).toBeGreaterThan(0.05);
      }
  });

  it("allocates nothing per set (the same array comes back)", () => {
    const w = createWarp(g);
    const ab = w.ab;
    w.set([0.5, 0.5, 0, 0], 0.3, [0, 0, 0.5, 0.5], 0.1, blend);
    expect(w.ab).toBe(ab);
  });
});

describe("palettes", () => {
  it("has neutral names, the first being the default-safe fallback", () => {
    expect(PALETTES).toEqual(["ink", "dusk", "four-block", "ochre", "watercolour"]);
  });

  it.each(PALETTES)("%s: paper, ink and at least three distinct tile colours, all 0–1", (name) => {
    const out = new Float32Array(6 + MAX_TILE_COLORS * 3);
    const n = paletteOf(name, out);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(MAX_TILE_COLORS);
    for (let i = 0; i < 6 + n * 3; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
    // Distinct tile colours keep any (cls + shift) mod n colouring valid.
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const d = Math.hypot(...[0, 1, 2].map((c) => out[6 + a * 3 + c] - out[6 + b * 3 + c]));
        expect(d).toBeGreaterThan(0.08);
      }
    // Paper is light and ink is dark.
    const lum = (/** @type {number} */ i) => 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
    expect(lum(0)).toBeGreaterThan(0.75);
    expect(lum(3)).toBeLessThan(0.25);
  });

  it("unknown names fall back to the first palette", () => {
    const a = new Float32Array(6 + MAX_TILE_COLORS * 3);
    const b = new Float32Array(6 + MAX_TILE_COLORS * 3);
    expect(paletteOf("nope", a)).toBe(paletteOf("ink", b));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("relief: the carved block's height field (mirrors tess.glsl tessRelief)", () => {
  const profiles = [0, 0.35, 1];

  it.each(profiles)("profile %s: 0 at the outline, 1 on the top, never outside 0–1", (pr) => {
    expect(reliefProfile(0, pr)).toBe(0);
    expect(reliefProfile(-0.1, pr)).toBe(0);
    expect(reliefProfile(RELIEF_DOME, pr)).toBeCloseTo(1, 9);
    expect(reliefProfile(0.4, pr)).toBeCloseTo(1, 9);
    let last = -1;
    for (let d = 0; d <= 0.3; d += 0.001) {
      const h = reliefProfile(d, pr);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(last); // rises from the groove to the top, no ridge
      last = h;
    }
  });

  it("a bevel tops out at its width, a dome only at the tile's centre", () => {
    expect(reliefProfile(RELIEF_BEVEL, 0)).toBeCloseTo(1, 9);
    expect(reliefProfile(RELIEF_BEVEL, 1)).toBeLessThan(0.5);
    expect(RELIEF_BEVEL).toBeLessThan(RELIEF_DOME);
  });

  it.each(profiles)("profile %s: the slope is the derivative and bounded (raymarch-safe)", (pr) => {
    const e = 1e-6;
    for (let d = 0.0005; d < 0.3; d += 0.0037) {
      const fd = (reliefProfile(d + e, pr) - reliefProfile(d - e, pr)) / (2 * e);
      expect(reliefSlope(d, pr)).toBeCloseTo(fd, 3);
      expect(Math.abs(reliefSlope(d, pr))).toBeLessThanOrEqual(2 / RELIEF_BEVEL + 1e-9);
    }
  });

  it("a card turning over: flat at 0 and 180 degrees, never below its bed, within its bound", () => {
    for (const hop of [0, 0.08]) {
      for (let th = 0; th <= Math.PI + 1e-9; th += Math.PI / 90) {
        for (let x = -CARD_HALF; x <= CARD_HALF + 1e-9; x += CARD_HALF / 20) {
          const h = cardHeight(x, th, hop);
          expect(h).toBeGreaterThanOrEqual(-1e-12);
          expect(h).toBeLessThanOrEqual((2 * CARD_HALF + hop) * Math.sin(th) + 1e-9);
        }
      }
      for (const x of [-CARD_HALF, 0.1, CARD_HALF]) {
        expect(cardHeight(x, 0, hop)).toBeCloseTo(0, 12);
        expect(cardHeight(x, Math.PI, hop)).toBeCloseTo(0, 9);
      }
    }
    // Edge-on, one edge stands up the full card width; the axis is half way.
    expect(cardHeight(CARD_HALF, Math.PI / 2, 0) + cardHeight(-CARD_HALF, Math.PI / 2, 0)).toBeCloseTo(2 * CARD_HALF, 9);
    expect(cardHeight(0, Math.PI / 2, 0)).toBeCloseTo(CARD_HALF, 9);
  });

  it("reliefBound covers every height the field can take (the march starts there)", () => {
    const r = rng(5);
    for (let i = 0; i < 4000; i++) {
      const relief = r();
      const liftMax = r() * 0.3;
      const popMax = r() * 0.1;
      const hop = r() * 0.1;
      const flipping = r() < 0.5;
      const th = flipping ? r() * Math.PI : 0;
      const tile = {
        prof: reliefProfile(r() * 0.3, r()),
        lift: (r() * 1.2 - 0.2) * liftMax,
        pop: r() * popMax,
        theta: th,
        x: (r() * 2 - 1) * CARD_HALF,
        hop,
      };
      const h = reliefHeight(relief, tile);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(reliefBound(relief, liftMax, popMax, flipping, hop) + 1e-9);
    }
    // At rest the bound is just the block.
    expect(reliefBound(1, 0, 0, false, 0)).toBeCloseTo(RELIEF_BLOCK, 9);
    expect(reliefBound(0, 0, 0, false, 0)).toBe(0);
  });
});
