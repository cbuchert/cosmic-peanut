// @ts-check
import { describe, expect, it } from "vitest";
import { BEND, HALF, LOOKS, NAVE, PERIOD, createKaleidoMusic, kaleidoClearance, kaleidoDE, naveDistance, rotation } from "./kaleido.js";

/** A look (bent by `bend` × BEND, −1…1, on every angle and offset) as KIFS parameters. */
function kifsOf(/** @type {number} */ i, /** @type {number} */ bend = 0) {
  const L = LOOKS[i];
  return {
    rot: rotation(L.angles.map((a) => a + bend * BEND.angle), new Float64Array(9)),
    offset: L.offset.map((o) => o + bend * BEND.offset),
    scale: L.scale,
  };
}

/** A deterministic pseudo-random point in a box around a node and its naves. */
function point(/** @type {number} */ i) {
  const f = (/** @type {number} */ k) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
  return [f(1) * 4 + 1, f(2) * 4 + 1, f(3) * 4 + 1];
}

const VARIANTS = LOOKS.flatMap((_, i) => [kifsOf(i, 0), kifsOf(i, 1), kifsOf(i, -1)]);

describe("kaleidoDE", () => {
  it("is a distance bound: the ball of 0.8 × its value never reaches the fractal", () => {
    for (const k of VARIANTS) {
      let worst = Infinity;
      for (let i = 0; i < 150; i++) {
        const p = point(i);
        const d = kaleidoDE(p, k);
        if (!(d > 0.005)) continue;
        for (let j = 0; j < 40; j++) {
          const q = point(i * 97 + j + 5000).map((x) => (x - 3) / 2); // −1…1
          const l = Math.hypot(q[0], q[1], q[2]) || 1;
          const r = 0.8 * d * ((j + 1) / 40);
          const s = p.map((x, c) => x + (q[c] / l) * r);
          worst = Math.min(worst, kaleidoDE(s, k));
        }
      }
      expect(worst).toBeGreaterThan(0);
    }
  });

  it("changes no faster than 1.25 × the distance moved (the march steps 0.8 of it)", () => {
    for (const k of VARIANTS) {
      let worst = 0;
      for (let i = 0; i < 2000; i++) {
        const p = point(i);
        const q = point(i + 9000).map((x) => (x - 3) / 2);
        const l = Math.hypot(q[0], q[1], q[2]) || 1;
        const h = 0.003;
        const s = p.map((x, c) => x + (q[c] / l) * h);
        worst = Math.max(worst, Math.abs(kaleidoDE(s, k) - kaleidoDE(p, k)) / h);
      }
      expect(worst).toBeLessThan(1.25);
    }
  });

  it("is tight enough to march: the running derivative keeps it near the true distance", () => {
    // Along random rays from points in the naves, sphere tracing reaches the surface found by
    // fine stepping in a modest number of steps, and lands within a hair of it.
    for (const k of VARIANTS) {
      let rays = 0;
      let steps = 0;
      for (let i = 0; i < 60; i++) {
        const o = [HALF + 0.3 * Math.sin(i), HALF + 0.3 * Math.cos(i * 1.3), 1 + 0.2 * i];
        const dir = point(i + 300).map((x) => x - 3);
        const l = Math.hypot(dir[0], dir[1], dir[2]);
        let t = 0;
        let n = 0;
        while (n < 400 && t < 12) {
          const d = kaleidoDE(o.map((x, c) => x + (dir[c] / l) * t), k);
          if (d < 0.0008 + 0.0015 * t) break; // the march's hit test
          t += 0.8 * d;
          n++;
        }
        if (t >= 12) continue;
        // Fine stepping finds no surface before t.
        for (let s = 0; s < t - 0.01; s += 2e-3) {
          expect(kaleidoDE(o.map((x, c) => x + (dir[c] / l) * s), k)).toBeGreaterThan(-1e-6);
        }
        rays++;
        steps += n;
      }
      expect(rays).toBeGreaterThan(20);
      expect(steps / rays).toBeLessThan(60);
    }
  });

  it("leaves the naves empty: inside a nave it is at least the distance to the nave wall", () => {
    for (const k of VARIANTS) {
      for (let i = 0; i < 300; i++) {
        const p = point(i);
        expect(kaleidoDE(p, k)).toBeGreaterThanOrEqual(NAVE - naveDistance(p) - 1e-12);
      }
    }
    // A nave axis: the cell edge, two coordinates on mid-planes.
    expect(naveDistance([HALF, HALF, 0.7])).toBe(0);
  });
});

describe("kaleidoClearance", () => {
  it("is the room left in the naves, negative at a node and beside it", () => {
    expect(kaleidoClearance([HALF, HALF, 1.3])).toBeCloseTo(NAVE, 9);
    expect(kaleidoClearance([0, 0, 0])).toBeLessThan(0);
    expect(kaleidoClearance([0.5, 0.01, 0.02])).toBeLessThan(0);
  });
});

describe("createKaleidoMusic", () => {
  const quiet = new Float32Array(64).fill(0.1);
  const loud = new Float32Array(64).fill(0.1);
  for (let i = 16; i < 64; i++) loud[i] = 0.9; // mids and treble up

  it("bends the folds slowly: a sudden lift in mids and treble eases in over seconds", () => {
    const m = createKaleidoMusic();
    for (let f = 0; f < 600; f++) m.step(quiet, 1 / 60, 1, false);
    const a0 = Array.from(m.angles);
    const o0 = Array.from(m.offset);
    m.step(loud, 1 / 60, 1, false);
    for (let f = 0; f < 5; f++) m.step(loud, 1 / 60, 1, false);
    // 0.1 s in: barely moved.
    const moved = (/** @type {number[]} */ a, /** @type {ArrayLike<number>} */ b) =>
      Math.max(...a.map((x, i) => Math.abs(x - b[i])));
    expect(moved(a0, m.angles)).toBeLessThan(0.005);
    for (let f = 0; f < 240; f++) m.step(loud, 1 / 60, 1, false);
    // 4 s in: well on its way, within the bend.
    expect(moved(a0, m.angles)).toBeGreaterThan(0.03);
    expect(moved(o0, m.offset)).toBeGreaterThan(0.03);
  });

  it("stays within the curated looks, bent at most ±BEND, and moves between them over minutes", () => {
    const m = createKaleidoMusic();
    const seen = new Set();
    for (let f = 0; f < 60 * 600; f++) {
      m.step(f % 90 < 45 ? loud : quiet, 1 / 60, 2, false);
      seen.add(m.look);
      // Between two looks: every value lies within the bent range spanned by them.
      const a = LOOKS[m.look];
      const b = LOOKS[(m.look + 1) % LOOKS.length];
      for (let i = 0; i < 3; i++) {
        const lo = Math.min(a.angles[i], b.angles[i]) - BEND.angle - 1e-9;
        const hi = Math.max(a.angles[i], b.angles[i]) + BEND.angle + 1e-9;
        expect(m.angles[i]).toBeGreaterThanOrEqual(lo);
        expect(m.angles[i]).toBeLessThanOrEqual(hi);
        const olo = Math.min(a.offset[i], b.offset[i]) - BEND.offset - 1e-9;
        const ohi = Math.max(a.offset[i], b.offset[i]) + BEND.offset + 1e-9;
        expect(m.offset[i]).toBeGreaterThanOrEqual(olo);
        expect(m.offset[i]).toBeLessThanOrEqual(ohi);
      }
      expect(m.scale).toBeGreaterThanOrEqual(Math.min(a.scale, b.scale) - 1e-9);
      expect(m.scale).toBeLessThanOrEqual(Math.max(a.scale, b.scale) + 1e-9);
    }
    expect(seen.size).toBe(LOOKS.length);
  });

  it("changes smoothly: no step in any parameter, even across a look change", () => {
    const m = createKaleidoMusic();
    let prev = [...m.angles, ...m.offset, m.scale];
    let worst = 0;
    for (let f = 0; f < 60 * 300; f++) {
      m.step(f % 30 < 3 ? loud : quiet, 1 / 60, 2, false);
      const now = [...m.angles, ...m.offset, m.scale];
      worst = Math.max(worst, ...now.map((x, i) => Math.abs(x - prev[i]) * 60));
      prev = now;
    }
    expect(worst).toBeLessThan(0.15); // per second
  });
});

describe("createKaleidoCamera", () => {
  it("flies the cubic camera's path scaled up to the naves, at SPEED cells per second", async () => {
    const { createKaleidoCamera } = await import("./structure-kaleidoscope.js");
    const { createCamera } = await import("./lattice-camera.js");
    const cam = createKaleidoCamera(5);
    const ref = createCamera(5);
    const out = new Float64Array(3);
    const refOut = new Float64Array(3);
    for (let f = 0; f < 240 * 20; f++) {
      if (f % 240 === 0) {
        cam.beat();
        ref.beat();
      }
      cam.update(1 / 240, 1);
      ref.update(1 / 240, 1.6 / PERIOD);
    }
    for (let c = 0; c < 3; c++) expect(cam.pos[c]).toBeCloseTo(ref.pos[c] * PERIOD, 9);
    expect(Array.from(cam.view.fwd)).toEqual(Array.from(ref.view.fwd));
    cam.ahead(2, out);
    ref.ahead(2 / PERIOD, refOut);
    for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(refOut[c] * PERIOD, 9);
    expect(cam.beatTurns).toBe(ref.beatTurns);
    expect(kaleidoClearance(cam.pos)).toBeGreaterThan(0.15);
  });
});
