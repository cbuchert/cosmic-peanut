// @ts-check
import { describe, expect, it } from "vitest";
import { createTessState } from "./tess-music.js";
import { createTile, drosteAlpha, drosteAt, fieldAt, groupOf, reliefHeight, reliefProfile, tileAt } from "./tess.js";
import { BLEND_PERIOD, LIFT_VARY, LIGHT_DEFAULT, RELIEF_DEFAULT } from "./tess-music.js";
import {
  cellKey,
  createDrag,
  createZoom,
  DIRECTIONS,
  directionSign,
  DRAG_MAX,
  DRAG_RETURN,
  readParams,
  ringSpan,
  seamCells,
  SPIRALS,
  spiralVector,
  VANISH,
  ZOOM_RATE,
} from "./tess-zoom.js";

/** A quiet audio frame for the tessellation state. */
const quiet = () => ({
  bands: new Float32Array(64),
  bpm: 0,
  beatPhase: 0,
  onset: false,
  onsetStrength: 0,
  centroid: 0.15,
  bassAtt: 1,
  silent: true,
});

/** The tessellation state's options for a group. @param {string} symmetry */
const opts = (symmetry) => ({
  symmetry,
  palette: "ink",
  reactivity: 1,
  speed: 1,
  morph: 0.7,
  ink: 1,
  hatching: 0.6,
  height: 1440,
  reduceMotion: false,
  reduceFlashing: false,
});

/** The state after one step: its warp coefficients and blend wave for a group. @param {string} symmetry */
function stateOf(symmetry) {
  const s = createTessState();
  s.step(quiet(), 1 / 60, opts(symmetry));
  return s;
}

describe.each(["p4", "p3"])("spiral closure, %s", (name) => {
  const g = groupOf(name);
  const s = stateOf(name);
  const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };

  it("offers a few twists, the first without a spiral", () => {
    expect(SPIRALS.length).toBeGreaterThanOrEqual(3);
    const v = [0, 0];
    expect(spiralVector(SPIRALS[0], v)[1]).toBe(0);
  });

  it.each(SPIRALS)("%s: one turn is a lattice step that the blend wave also repeats over", (sp) => {
    const v = spiralVector(sp, [0, 0]);
    expect(Number.isInteger(v[0]) && Number.isInteger(v[1])).toBe(true);
    const vx = v[0] * g.basis[0][0] + v[1] * g.basis[1][0];
    const vy = v[0] * g.basis[0][1] + v[1] * g.basis[1][1];
    const kv = blend.kx * vx + blend.ky * vy;
    expect(Math.abs(kv - Math.round(kv))).toBeLessThan(1e-6); // the wave is stored as Float32
  });

  it.each(SPIRALS)("%s: tiles, field and blend line up across the seam", (sp) => {
    const v = spiralVector(sp, [0, 0]);
    const alpha = drosteAlpha(g, v[0], v[1], [0, 0]);
    const a = createTile();
    const b = createTile();
    const pa = [0, 0];
    const pb = [0, 0];
    const fa = [0, 0];
    const fb = [0, 0];
    for (let i = 0; i < 100; i++) {
      const rad = 0.03 + i * 0.011;
      drosteAt(alpha, -rad, 1e-7, pa);
      drosteAt(alpha, -rad, -1e-7, pb);
      fieldAt(g, s.ab, blend, pa[0], pa[1], fa);
      fieldAt(g, s.ab, blend, pb[0], pb[1], fb);
      expect(fb[0]).toBeCloseTo(fa[0], 4);
      expect(fb[1]).toBeCloseTo(fa[1], 4);
      tileAt(g, pa[0] + fa[0], pa[1] + fa[1], a);
      tileAt(g, pb[0] + fb[0], pb[1] + fb[1], b);
      if (a.dist < 1e-4) continue;
      expect(b.cls).toBe(a.cls);
      expect(b.u).toBeCloseTo(a.u, 3);
      expect(b.v).toBeCloseTo(a.v, 3);
    }
  });
});

/**
 * The engine's integer tile id (tess.glsl tessTile's `cell`) at a tile-plane point: p4 the
 * half-unit square floor(2q); p3 3 × the nearest lattice point plus the rhombus (x only).
 * @param {import('./tess.js').Group} g @param {number} x @param {number} y @param {import('./tess.js').Tile} t tileAt there
 */
function cellOf(g, x, y, t) {
  if (g.order === 4) return [Math.floor(2 * x), Math.floor(2 * y)];
  const b = y / (Math.sqrt(3) / 2);
  const a = x - b / 2;
  let best = [0, 0];
  let bd = Infinity;
  for (let i = 0; i < 4; i++) {
    const c = [Math.floor(a) + (i & 1), Math.floor(b) + (i >> 1)];
    const d = (x - c[0] - c[1] / 2) ** 2 + (y - (c[1] * Math.sqrt(3)) / 2) ** 2;
    if (d < bd) [bd, best] = [d, c];
  }
  return [3 * best[0] + t.orient, 3 * best[1]];
}

/** tess.glsl tessHash12 (the per-tile lift variation and pop choice hash a tile's cell key). */
function hash12(/** @type {number} */ x, /** @type {number} */ y) {
  const fr = (/** @type {number} */ v) => v - Math.floor(v);
  let [a, b, c] = [fr(x * 0.1031), fr(y * 0.1031), fr(x * 0.1031)];
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  [a, b, c] = [a + d, b + d, c + d];
  return fr((a + b) * c);
}

describe.each(["p4", "p3"])("relief closure across the seam, %s", (name) => {
  const g = groupOf(name);
  const s = stateOf(name);
  const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };

  it.each(SPIRALS)("%s: one turn moves the engine's cell id by the seam's cells", (sp) => {
    const v = spiralVector(sp, [0, 0]);
    const seam = seamCells(g, sp, [0, 0]);
    const t = createTile();
    // A tile's centre and the same tile one turn on, V = a e1 + b e2 away.
    const vx = v[0] * g.basis[0][0] + v[1] * g.basis[1][0];
    const vy = v[0] * g.basis[0][1] + v[1] * g.basis[1][1];
    for (const [x, y] of [[0.13, 0.27], [-1.4, 2.2], [3.3, -0.6]]) {
      const c0 = cellOf(g, x, y, tileAt(g, x, y, t));
      const c1 = cellOf(g, x + vx, y + vy, tileAt(g, x + vx, y + vy, t));
      expect([c1[0] - c0[0], c1[1] - c0[1]]).toEqual(seam);
    }
  });

  it.each(SPIRALS)("%s: a tile's height is the same either side of the seam", (sp) => {
    const v = spiralVector(sp, [0, 0]);
    const alpha = drosteAlpha(g, v[0], v[1], [0, 0]);
    const seam = seamCells(g, sp, [0, 0]);
    const base = [7, -40]; // any accumulated offset (createZoom cellBase)
    const O = [0.37, -0.21];
    const ta = createTile();
    const tb = createTile();
    const pa = [0, 0];
    const pb = [0, 0];
    const fa = [0, 0];
    const fb = [0, 0];
    const ka = [0, 0];
    const kb = [0, 0];
    let checked = 0;
    for (let i = 0; i < 100; i++) {
      const rad = 0.03 + i * 0.011;
      drosteAt(alpha, -rad, 1e-7, pa); // just above the seam (the atan wrap, left of centre)…
      drosteAt(alpha, -rad, -1e-7, pb); // …and just below it
      pa[0] += O[0];
      pa[1] += O[1];
      pb[0] += O[0];
      pb[1] += O[1];
      fieldAt(g, s.ab, blend, pa[0], pa[1], fa);
      fieldAt(g, s.ab, blend, pb[0], pb[1], fb);
      const qa = [pa[0] + fa[0], pa[1] + fa[1]];
      const qb = [pb[0] + fb[0], pb[1] + fb[1]];
      tileAt(g, qa[0], qa[1], ta);
      tileAt(g, qb[0], qb[1], tb);
      if (ta.dist < 1e-4) continue;
      const ca = cellOf(g, qa[0], qa[1], ta);
      const cb = cellOf(g, qb[0], qb[1], tb);
      expect(ca).not.toEqual(cb); // the raw ids differ by a turn…
      cellKey(ca[0], ca[1], base, seam, ka);
      cellKey(cb[0], cb[1], base, seam, kb);
      expect(kb).toEqual(ka); // …their keys don't
      // The height (tess.glsl tessPlate): profile, ring lift varied by the key's hash, the ring
      // by log radius (the same either side: Re log z doesn't wrap).
      const lift = 0.1;
      const at = (/** @type {import('./tess.js').Tile} */ t, /** @type {number[]} */ k) => ({
        prof: reliefProfile(t.dist, 0.35),
        lift: lift * (1 - LIFT_VARY + 2 * LIFT_VARY * hash12(k[0] * 0.731 + 3.7, k[1] * 0.731 + 3.7)),
        pop: 0,
        theta: 0,
        x: 0,
        hop: 0,
      });
      expect(reliefHeight(RELIEF_DEFAULT, at(tb, kb))).toBeCloseTo(reliefHeight(RELIEF_DEFAULT, at(ta, ka)), 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("keys stay small, integer and reduced across a turn", () => {
    const seam = seamCells(g, "medium", [0, 0]);
    const k = [0, 0];
    for (const [x, y] of [[0, 0], [11, 3], [-25, 40], [1e4, -7]]) {
      cellKey(x, y, [0, 0], seam, k);
      expect(k[0]).toBeGreaterThanOrEqual(0);
      expect(k[0]).toBeLessThan(seam[0]);
      expect(Number.isInteger(k[0]) && Number.isInteger(k[1])).toBe(true);
      const k2 = cellKey(x + 3 * seam[0], y + 3 * seam[1], [0, 0], seam, [0, 0]);
      expect(k2).toEqual(k);
    }
  });
});

/** Log radius (screen units) at which a fixed plane point sits: Re((p − O) / α). */
function logRadius(/** @type {ReturnType<typeof createZoom>} */ z, /** @type {number} */ px, /** @type {number} */ py) {
  const [ax, ay] = z.alpha;
  const dx = px - z.ox;
  const dy = py - z.oy;
  return (dx * ax + dy * ay) / (ax * ax + ay * ay);
}

describe.each(["p4", "p3"])("zoom, %s", (name) => {
  const g = groupOf(name);
  const zin = { group: g, spiral: "medium", zoomSpeed: 1, direction: "in" };

  it("zooming in carries the plane outward from the vanishing point, at the travel's pace", () => {
    const z = createZoom();
    z.step(0, 1 / 60, zin);
    const r0 = logRadius(z, 0.3, 0.2);
    let ux = z.ox;
    let uy = z.oy;
    for (let i = 0; i < 30; i++) {
      z.step(0.02, 1 / 60, zin);
      ux -= z.alpha[0] * z.lastStep; // the offset before any wrap
      uy -= z.alpha[1] * z.lastStep;
    }
    expect(z.phase).toBeCloseTo(30 * 0.02 * ZOOM_RATE, 9);
    const r1 = logRadius({ ...z, ox: ux, oy: uy }, 0.3, 0.2);
    expect(r1 - r0).toBeCloseTo(z.phase, 9); // log r grows: the point moves outward
  });

  it("zooming out runs the other way; a direction change eases instead of snapping", () => {
    const z = createZoom();
    for (let i = 0; i < 600; i++) z.step(0.02, 1 / 60, zin);
    const before = z.phase;
    z.step(0.02, 1 / 60, zin);
    const perStep = z.phase - before;
    const zout = { ...zin, direction: "out" };
    let last = z.phase;
    let prevRate = perStep;
    for (let i = 0; i < 600; i++) {
      z.step(0.02, 1 / 60, zout);
      const rate = z.phase - last;
      last = z.phase;
      expect(Math.abs(rate - prevRate)).toBeLessThan(0.1 * Math.abs(perStep)); // no jolt
      prevRate = rate;
    }
    expect(prevRate).toBeCloseTo(-perStep, 6);
  });

  it("Zoom speed scales it and 0 holds the view", () => {
    const a = createZoom();
    const b = createZoom();
    const c = createZoom();
    for (let i = 0; i < 10; i++) {
      a.step(0.02, 1 / 60, zin);
      b.step(0.02, 1 / 60, { ...zin, zoomSpeed: 2 });
      c.step(0.02, 1 / 60, { ...zin, zoomSpeed: 0 });
    }
    expect(b.phase).toBeCloseTo(2 * a.phase, 9);
    expect(c.phase).toBe(0);
    expect([c.ox, c.oy]).toEqual([0, 0]);
  });

  it("the offset wraps by whole blend periods of the lattice, so the zoom never jumps", () => {
    const z = createZoom();
    const s = stateOf(name);
    const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
    const det = g.basis[0][0] * g.basis[1][1] - g.basis[1][0] * g.basis[0][1];
    const fa = [0, 0];
    const fb = [0, 0];
    const ta = createTile();
    const tb = createTile();
    let wraps = 0;
    for (let i = 0; i < 4000; i++) {
      const ox = z.ox;
      const oy = z.oy;
      z.step(0.05, 1 / 60, zin);
      // The unwrapped offset: O − α·Δphase.
      const ux = ox - z.alpha[0] * z.lastStep;
      const uy = oy - z.alpha[1] * z.lastStep;
      const dx = z.ox - ux;
      const dy = z.oy - uy;
      const la = (dx * g.basis[1][1] - dy * g.basis[1][0]) / det;
      const lb = (dy * g.basis[0][0] - dx * g.basis[0][1]) / det;
      expect(Math.abs(la / BLEND_PERIOD - Math.round(la / BLEND_PERIOD))).toBeLessThan(1e-9);
      expect(Math.abs(lb / BLEND_PERIOD - Math.round(lb / BLEND_PERIOD))).toBeLessThan(1e-9);
      if (Math.abs(dx) + Math.abs(dy) > 1e-9) {
        wraps++;
        // Same picture either side of the wrap.
        fieldAt(g, s.ab, blend, ux + 0.4, uy + 0.1, fa);
        fieldAt(g, s.ab, blend, z.ox + 0.4, z.oy + 0.1, fb);
        expect(fb[0]).toBeCloseTo(fa[0], 5);
        expect(fb[1]).toBeCloseTo(fa[1], 5);
        tileAt(g, ux + 0.4 + fa[0], uy + 0.1 + fa[1], ta);
        tileAt(g, z.ox + 0.4 + fb[0], z.oy + 0.1 + fb[1], tb);
        expect(tb.cls).toBe(ta.cls);
        expect(tb.u).toBeCloseTo(ta.u, 4);
      }
      // …and the offset stays small (floats keep their precision).
      expect(Math.hypot(z.ox, z.oy)).toBeLessThan(2 * BLEND_PERIOD);
    }
    expect(wraps).toBeGreaterThan(0);
  });

  it("tiles keep their cell keys (so their heights) across the offset's wraps", () => {
    const z = createZoom();
    const s = stateOf(name);
    const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
    const t = createTile();
    const f = [0, 0];
    const ka = [0, 0];
    const kb = [0, 0];
    let wraps = 0;
    for (let i = 0; i < 4000; i++) {
      const ox = z.ox;
      const oy = z.oy;
      const bx = z.cellBase[0];
      const by = z.cellBase[1];
      z.step(0.05, 1 / 60, zin);
      const ux = ox - z.alpha[0] * z.lastStep;
      const uy = oy - z.alpha[1] * z.lastStep;
      if (Math.abs(z.ox - ux) + Math.abs(z.oy - uy) < 1e-9) continue;
      wraps++;
      for (const [dx, dy] of [[0.4, 0.1], [-1.3, 0.7], [2.1, -2.6]]) {
        fieldAt(g, s.ab, blend, ux + dx, uy + dy, f);
        const qa = [ux + dx + f[0], uy + dy + f[1]];
        fieldAt(g, s.ab, blend, z.ox + dx, z.oy + dy, f);
        const qb = [z.ox + dx + f[0], z.oy + dy + f[1]];
        const ca = cellOf(g, qa[0], qa[1], tileAt(g, qa[0], qa[1], t));
        const cb = cellOf(g, qb[0], qb[1], tileAt(g, qb[0], qb[1], t));
        cellKey(ca[0], ca[1], [bx, by], z.seam, ka); // the same tile, before the wrap…
        cellKey(cb[0], cb[1], z.cellBase, z.seam, kb); // …and after it
        expect(kb).toEqual(ka);
      }
    }
    expect(wraps).toBeGreaterThan(0);
    expect(z.seam).toEqual(seamCells(g, "medium", [0, 0]));
  });

  it("follows the spiral: α closes the chosen lattice vector", () => {
    const z = createZoom();
    z.step(0, 1 / 60, zin);
    const v = spiralVector("medium", [0, 0]);
    expect(z.alpha).toEqual(drosteAlpha(g, v[0], v[1], [0, 0]));
  });
});

describe("drag of the vanishing point", () => {
  const unit = 360; // CSS px per screen unit (half the short side)

  it("follows the pointer while held (y up), within DRAG_MAX of the centre", () => {
    const d = createDrag();
    d.pointer("down", 0, 0, unit);
    d.pointer("move", 36, 18, unit);
    d.step(1 / 60);
    expect(d.x).toBeCloseTo(0.1, 9);
    expect(d.y).toBeCloseTo(-0.05, 9);
    for (let i = 0; i < 100; i++) d.step(1 / 60); // held: stays put
    expect(d.x).toBeCloseTo(0.1, 9);
    d.pointer("move", 5000, 0, unit);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(DRAG_MAX, 9);
  });

  it("eases back to the centre after release, smoothly and monotonically", () => {
    const d = createDrag();
    d.pointer("down", 0, 0, unit);
    d.pointer("move", 90, 0, unit);
    d.pointer("up", 0, 0, unit);
    const x0 = d.x;
    let last = x0;
    let lastV = 0;
    const dt = 1 / 120;
    for (let t = 0; t < DRAG_RETURN + 0.2; t += dt) {
      d.step(dt);
      expect(d.x).toBeLessThanOrEqual(last + 1e-12);
      const v = last - d.x;
      expect(Math.abs(v - lastV)).toBeLessThan(0.01 * x0); // no kick at release or anywhere
      lastV = v;
      last = d.x;
    }
    expect(d.x).toBe(0);
    expect(d.y).toBe(0);
  });

  it("a new grab mid-return picks up from where the point is", () => {
    const d = createDrag();
    d.pointer("down", 0, 0, unit);
    d.pointer("move", 90, 0, unit);
    d.pointer("up", 0, 0, unit);
    for (let i = 0; i < 30; i++) d.step(1 / 60);
    const x = d.x;
    d.pointer("down", 0, 0, unit);
    d.step(1 / 60);
    expect(d.x).toBeCloseTo(x, 9);
  });
});

describe("rings by log radius", () => {
  it("run from the vanishing point's soft edge to the farthest corner", () => {
    const out = [0, 0];
    ringSpan(16 / 9, 1, 0, 0, out);
    expect(out[0]).toBeCloseTo(Math.log(VANISH[1]), 9);
    expect(out[1]).toBeCloseTo(Math.log(Math.hypot(16 / 9, 1)), 9);
    ringSpan(16 / 9, 1, -0.5, 0.3, out); // dragged left and up: the far corner is right, down
    expect(out[1]).toBeCloseTo(Math.log(Math.hypot(16 / 9 + 0.5, 1.3)), 9);
  });

  it("the soft vanishing point is inside the view", () => {
    expect(VANISH[0]).toBeGreaterThanOrEqual(0);
    expect(VANISH[1]).toBeGreaterThan(VANISH[0]);
    expect(VANISH[1]).toBeLessThan(0.5);
  });
});

describe("param mapping", () => {
  const o = () => ({
    symmetry: "",
    palette: "",
    reactivity: 0,
    speed: 0,
    morph: 0,
    ink: 0,
    hatching: 0,
    spiral: "",
    zoomSpeed: 0,
    direction: "",
    relief: 0,
    light: 0,
  });

  it("reads Metamorphosis's params (Relief and Light too) plus Spiral, Zoom speed and Direction", () => {
    const out = readParams(
      { symmetry: "p3", palette: "ochre", reactivity: 1.5, speed: 0.5, morph: 0.4, ink: 1.2, hatching: 0.3, relief: 0.8, light: 200, spiral: "strong", zoom: 1.7, direction: "out" },
      o(),
    );
    expect(out).toEqual({
      symmetry: "p3",
      palette: "ochre",
      reactivity: 1.5,
      speed: 0.5,
      morph: 0.4,
      ink: 1.2,
      hatching: 0.3,
      spiral: "strong",
      zoomSpeed: 1.7,
      direction: "out",
      relief: 0.8,
      light: 200,
    });
  });

  it("Relief 0 is the flat print; Relief and Light fall back to the defaults when missing", () => {
    expect(readParams({ relief: 0 }, o()).relief).toBe(0);
    const out = readParams({}, o());
    expect(out.relief).toBe(RELIEF_DEFAULT);
    expect(out.light).toBe(LIGHT_DEFAULT);
  });

  it("clamps and falls back on anything out of range", () => {
    const out = readParams(
      { symmetry: "p6", palette: "x", reactivity: 9, speed: -1, morph: 3, ink: -2, hatching: 4, relief: 5, light: 400, spiral: "huge", zoom: -1, direction: "sideways" },
      o(),
    );
    expect(out.relief).toBe(1);
    expect(out.light).toBe(360);
    expect(readParams({ relief: -1, light: -5 }, o())).toMatchObject({ relief: 0, light: 0 });
    expect(out.symmetry).toBe("p4");
    expect(out.reactivity).toBe(2);
    expect(out.speed).toBe(0);
    expect(out.morph).toBe(1);
    expect(out.ink).toBe(0);
    expect(out.hatching).toBe(1);
    expect(SPIRALS).toContain(out.spiral);
    expect(out.zoomSpeed).toBe(0);
    expect(out.direction).toBe("in");
    expect(DIRECTIONS).toEqual(["in", "out"]);
    expect(directionSign("out")).toBe(-1);
    expect(directionSign("in")).toBe(1);
  });
});
