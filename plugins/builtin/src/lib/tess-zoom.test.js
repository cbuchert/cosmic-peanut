// @ts-check
import { describe, expect, it } from "vitest";
import { createTessState } from "./tess-music.js";
import { createTile, drosteAlpha, drosteAt, fieldAt, groupOf, tileAt } from "./tess.js";
import { BLEND_PERIOD } from "./tess-music.js";
import {
  createDrag,
  createZoom,
  DIRECTIONS,
  directionSign,
  DRAG_MAX,
  DRAG_RETURN,
  readParams,
  ringSpan,
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
  });

  it("reads Metamorphosis's params plus Spiral, Zoom speed and Direction", () => {
    const out = readParams(
      { symmetry: "p3", palette: "ochre", reactivity: 1.5, speed: 0.5, morph: 0.4, ink: 1.2, hatching: 0.3, spiral: "strong", zoom: 1.7, direction: "out" },
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
    });
  });

  it("clamps and falls back on anything out of range", () => {
    const out = readParams(
      { symmetry: "p6", palette: "x", reactivity: 9, speed: -1, morph: 3, ink: -2, hatching: 4, spiral: "huge", zoom: -1, direction: "sideways" },
      o(),
    );
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
