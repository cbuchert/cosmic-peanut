// @ts-check
import { describe, expect, it } from "vitest";
import {
  cellClass,
  faceCells,
  faceJacobian,
  faceOf,
  FACES,
  flipDir,
  fromFace,
  hash12,
  poleRing,
  sphereTables,
  tileColor,
  tileKey,
  tileRelief,
  toFace,
  transitions,
  turn,
} from "./cube-sphere.js";
import { createWarp, fieldAt, groupOf, RELIEF_BLOCK, reliefProfile } from "./tess.js";
import { BLEND_PERIOD, LIFT_VARY } from "./tess-music.js";

const N = 3;

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("faceCells", () => {
  it("picks lattice cells per face that divide or are a multiple of BLEND_PERIOD, nearest the target", () => {
    expect(faceCells(3)).toBe(3);
    expect(faceCells(5.4)).toBe(6);
    expect(faceCells(4)).toBe(3);
    expect(faceCells(0.2)).toBe(1);
    expect(faceCells(14)).toBe(12);
    for (let t = 0.5; t < 30; t += 0.7) {
      const n = faceCells(t);
      expect(Number.isInteger(n)).toBe(true);
      expect(BLEND_PERIOD % n === 0 || n % BLEND_PERIOD === 0).toBe(true);
    }
  });
});

describe("cube-sphere chart (equal-angle)", () => {
  const p = [0, 0];
  const d = [0, 0, 0];

  it("has six right-handed faces: u × v = n, so every chart keeps the orientation", () => {
    expect(FACES).toHaveLength(6);
    for (const { n, u, v } of FACES) {
      const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      expect(c).toEqual(n);
    }
  });

  it("maps a face onto [0, N]², centre to centre, corners to the cube corners", () => {
    expect(FACES).toHaveLength(6);
    FACES.forEach((F, f) => {
      toFace(f, F.n[0], F.n[1], F.n[2], N, p);
      expect(p[0]).toBeCloseTo(N / 2, 12);
      expect(p[1]).toBeCloseTo(N / 2, 12);
      const cx = F.n[0] + F.u[0] + F.v[0];
      const cy = F.n[1] + F.u[1] + F.v[1];
      const cz = F.n[2] + F.u[2] + F.v[2];
      toFace(f, cx, cy, cz, N, p);
      expect(p[0]).toBeCloseTo(N, 12);
      expect(p[1]).toBeCloseTo(N, 12);
      expect(faceOf(F.n[0], F.n[1], F.n[2])).toBe(f);
    });
  });

  it("round-trips: fromFace(toFace(d)) = d / |d|", () => {
    const r = rng();
    for (let i = 0; i < 300; i++) {
      const x = r() * 2 - 1;
      const y = r() * 2 - 1;
      const z = r() * 2 - 1;
      const f = faceOf(x, y, z);
      toFace(f, x, y, z, N, p);
      expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(p[0]).toBeLessThanOrEqual(N + 1e-9);
      fromFace(f, p[0], p[1], N, d);
      const l = Math.hypot(x, y, z);
      expect(d[0]).toBeCloseTo(x / l, 10);
      expect(d[1]).toBeCloseTo(y / l, 10);
      expect(d[2]).toBeCloseTo(z / l, 10);
    }
  });

  it("is equal-angle: equal steps along a face's centre line are equal angles on the sphere", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const steps = 12;
    let first = 0;
    for (let i = 0; i < steps; i++) {
      fromFace(0, (i / steps) * N, N / 2, N, a);
      fromFace(0, ((i + 1) / steps) * N, N / 2, N, b);
      const ang = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
      if (i === 0) first = ang;
      expect(ang).toBeCloseTo(first, 9);
    }
    expect(first * steps).toBeCloseTo(Math.PI / 2, 9);
  });

  it("has an analytic Jacobian dp/dh that matches finite differences, up to and on the edges", () => {
    const J = new Float64Array(6);
    const r = rng(3);
    const h = 1e-6;
    const q = [0, 0];
    for (let i = 0; i < 200; i++) {
      // Directions on a face, including exactly on its edges (|a| = 1).
      const f = Math.floor(r() * 6);
      const px = i % 5 === 0 ? N : r() * N;
      fromFace(f, px, r() * N, N, d);
      faceJacobian(f, d[0], d[1], d[2], N, J);
      // A face spans N plane units over 90°: the Jacobian is never small on the unit sphere.
      expect(Math.hypot(...J)).toBeGreaterThan(N / 2);
      for (let c = 0; c < 3; c++) {
        const e = [d[0], d[1], d[2]];
        e[c] += h;
        toFace(f, e[0], e[1], e[2], N, q);
        e[c] -= 2 * h;
        toFace(f, e[0], e[1], e[2], N, p);
        expect(J[c]).toBeCloseTo((q[0] - p[0]) / (2 * h), 5);
        expect(J[3 + c]).toBeCloseTo((q[1] - p[1]) / (2 * h), 5);
      }
    }
  });
});

describe("face transitions", () => {
  const T = transitions(N);
  const p = [0, 0];
  const q = [0, 0];
  const d = [0, 0, 0];

  it("are quarter turns plus a translation by whole faces, exact along every shared edge", () => {
    expect(T).toHaveLength(24);
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        const t = T[f * 4 + s];
        expect(t.g).not.toBe(f);
        expect([0, 1, 2, 3]).toContain(t.k);
        expect(Number.isInteger(t.tx / N) && Number.isInteger(t.ty / N)).toBe(true);
        for (let i = 0; i <= 10; i++) {
          const along = (i / 10) * N;
          const pf = [
            [N, along],
            [0, along],
            [along, N],
            [along, 0],
          ][s];
          fromFace(f, pf[0], pf[1], N, d);
          toFace(t.g, d[0], d[1], d[2], N, p);
          turn(pf[0], pf[1], t.k, q);
          expect(q[0] + t.tx).toBeCloseTo(p[0], 9);
          expect(q[1] + t.ty).toBeCloseTo(p[1], 9);
        }
      }
    }
  });

  it("pair up: crossing back from the neighbour undoes the move", () => {
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        const t = T[f * 4 + s];
        const back = T.filter((b, j) => Math.floor(j / 4) === t.g && b.g === f);
        expect(back).toHaveLength(1);
        expect((t.k + back[0].k) % 4).toBe(0);
      }
    }
  });

  it("turn an odd number of quarters around every cube corner (the corner's 90° deficit)", () => {
    // That is why a two-class checkerboard cannot close up on a cube: the colouring needs seams.
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz]);
    for (const c of corners) {
      const fs = [0, 1, 2].map((axis) => axis * 2 + (c[axis] > 0 ? 0 : 1));
      let sum = 0;
      for (const f of fs) for (const g of fs) if (f < g) sum += T.find((t, j) => Math.floor(j / 4) === f && t.g === g)?.k ?? NaN;
      expect(sum % 2).toBe(1);
    }
  });
});

describe("tile colours across the cube", () => {
  const tab = sphereTables(N);
  const T = transitions(N);
  const M = 2 * N; // tiles (half-unit cells) per face side
  const c = [0, 0];

  /** The cell across side s of face f's cell (i, j), in the neighbour's chart. */
  function across(/** @type {number} */ f, /** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ s) {
    const di = [1, -1, 0, 0][s];
    const dj = [0, 0, 1, -1][s];
    const t = T[f * 4 + s];
    turn((i + di + 0.5) / 2, (j + dj + 0.5) / 2, t.k, c);
    return { g: t.g, i: Math.floor(2 * (c[0] + t.tx)), j: Math.floor(2 * (c[1] + t.ty)) };
  }
  const color = (/** @type {number} */ f, /** @type {number} */ i, /** @type {number} */ j) => tileColor(tab, N, f, i, j, cellClass(i, j));

  it("are the same seen from either face: a tile beyond an edge takes its owner's colour", () => {
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        for (let a = 0; a < M; a++) {
          const [i, j] = [
            [M, a],
            [-1, a],
            [a, M],
            [a, -1],
          ][s];
          const o = across(f, i - [1, -1, 0, 0][s], j - [0, 0, 1, -1][s], s);
          expect(o.i).toBeGreaterThanOrEqual(0);
          expect(o.i).toBeLessThan(M);
          expect(o.j).toBeGreaterThanOrEqual(0);
          expect(o.j).toBeLessThan(M);
          expect(color(f, i, j)).toBe(color(o.g, o.i, o.j));
        }
      }
    }
  });

  it("never give neighbours one colour, the three tiles at each cube corner included", () => {
    let clashes = 0;
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < M; i++) {
        for (let j = 0; j < M; j++) {
          const me = color(f, i, j);
          expect([0, 1, 2]).toContain(me);
          for (let s = 0; s < 4; s++) {
            const inside = [i + 1 < M, i > 0, j + 1 < M, j > 0][s];
            const o = inside ? { g: f, i: i + [1, -1, 0, 0][s], j: j + [0, 0, 1, -1][s] } : across(f, i, j, s);
            if (color(o.g, o.i, o.j) === me) clashes++;
          }
        }
      }
    }
    // (On the regular cells; the warp still distorts the tiles right at a corner.)
    expect(clashes).toBe(0);
  });

  it("only use the third colour along the four seam edges, and sparingly", () => {
    let third = 0;
    for (let f = 0; f < 6; f++) for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) if (color(f, i, j) === 2) third++;
    let seams = 0;
    for (let k = 0; k < 24; k++) seams += tab.nb[k * 4 + 2];
    expect(seams / 2).toBe(4);
    expect(third).toBe(4 * M);
  });

  it("packs uniform-ready tables: face frames, neighbours, offsets, flips", () => {
    expect(tab.frames).toHaveLength(6 * 9);
    expect(tab.nb).toBeInstanceOf(Int32Array);
    expect(tab.nb).toHaveLength(24 * 4);
    expect(tab.nbT).toHaveLength(24 * 2);
    expect(tab.flip).toHaveLength(6);
    for (let k = 0; k < 24; k++) {
      expect(tab.nb[k * 4]).toBe(T[k].g);
      expect(tab.nb[k * 4 + 1]).toBe(T[k].k);
      expect(tab.nbT[k * 2]).toBe(T[k].tx);
    }
  });
});

describe("relief across the cube (the tiles lift off the globe with no step at an edge)", () => {
  const tab = sphereTables(N);
  const T = transitions(N);
  const M = 2 * N;
  const g4 = groupOf("p4");
  const warp = createWarp(g4);
  // The sphere's blend runs in time only (u_tBlend.xy = 0), so the field is one mix everywhere.
  const still = { kx: 0, ky: 0, phase: 0.4 };
  warp.set([0.5, 0.2, 0.1, 0.2], 0.3, [0.1, 0.6, 0.3, 0], 1.1, still);
  const fd = [0, 0];
  /** tess.glsl tessWarp: TESS_STEPS (4) steps of the field, composed. */
  function warpPoint(/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ out) {
    out[0] = x;
    out[1] = y;
    for (let i = 0; i < 4; i++) {
      fieldAt(g4, warp.ab, still, out[0], out[1], fd);
      out[0] += fd[0];
      out[1] += fd[1];
    }
    return out;
  }
  const pole = [0.3, -0.5, 0.81];
  const pl = Math.hypot(...pole);
  pole.forEach((v, i) => (pole[i] = v / pl));
  /** The music's state, as a function of the ring: a wave front part way out, a card flip under way. */
  const music = {
    relief: 0.8,
    profile: 0.35,
    pole,
    liftAt: (/** @type {number} */ ring) => 0.12 * Math.exp(-(((ring - 0.45) / 0.2) ** 2)) + 0.03 * ring,
    front: 0.55,
    width: 0.35,
    hop: 0.08,
    pops: [0.05, 0.5, 3.3, 0, 0, 0, 0, 0, 0.04, 0.3, 7.1, 0],
  };
  const key = [0, 0, 0];
  const other = [0, 0, 0];
  const b = [0, 0];
  const b2 = [0, 0];
  const c = [0, 0];

  /** The tile across side s of face f's cell (i, j): neighbour face and its cell there. */
  function across(/** @type {number} */ f, /** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ s) {
    const di = [1, -1, 0, 0][s];
    const dj = [0, 0, 1, -1][s];
    const t = T[f * 4 + s];
    turn((i + di + 0.5) / 2, (j + dj + 0.5) / 2, t.k, c);
    return { g: t.g, k: t.k, i: Math.floor(2 * (c[0] + t.tx)), j: Math.floor(2 * (c[1] + t.ty)) };
  }

  it("keys each tile by its owner: the same id (and ring) seen from either face", () => {
    const seen = new Set();
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        for (let a = 0; a < M; a++) {
          const [i, j] = [
            [M, a],
            [-1, a],
            [a, M],
            [a, -1],
          ][s];
          const o = across(f, i - [1, -1, 0, 0][s], j - [0, 0, 1, -1][s], s);
          tileKey(tab, N, f, (i + 0.5) / 2, (j + 0.5) / 2, key);
          tileKey(tab, N, o.g, (o.i + 0.5) / 2, (o.j + 0.5) / 2, other);
          expect([key[0], key[1]]).toEqual([other[0], other[1]]);
          expect(poleRing(tab, N, f, (i + 0.5) / 2, (j + 0.5) / 2, pole)).toBeCloseTo(poleRing(tab, N, o.g, (o.i + 0.5) / 2, (o.j + 0.5) / 2, pole), 12);
        }
      }
      for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) seen.add(tileKey(tab, N, f, (i + 0.5) / 2, (j + 0.5) / 2, key).slice(0, 2).join());
    }
    // One id per tile of the sphere: 6 faces × M² tiles, none shared.
    expect(seen.size).toBe(6 * M * M);
  });

  it("turns cards across the front's direction, away from the pole, the same tile alike from either face", () => {
    const d = [0, 0, 0];
    const J = new Float64Array(6);
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        for (let a = 0; a < M; a++) {
          const [i, j] = [
            [M, a],
            [-1, a],
            [a, M],
            [a, -1],
          ][s];
          const o = across(f, i - [1, -1, 0, 0][s], j - [0, 0, 1, -1][s], s);
          flipDir(tab, N, f, (i + 0.5) / 2, (j + 0.5) / 2, pole, b);
          flipDir(tab, N, o.g, (o.i + 0.5) / 2, (o.j + 0.5) / 2, pole, b2);
          expect(Math.hypot(b[0], b[1])).toBeCloseTo(1, 12);
          // Chart vectors carry across the edge by the crossing's quarter turn.
          turn(b[0], b[1], o.k, c);
          expect(c[0]).toBeCloseTo(b2[0], 9);
          expect(c[1]).toBeCloseTo(b2[1], 9);
        }
      }
      // On a face, a small step along it moves away from the pole.
      for (let i = 0; i < M; i++) {
        for (let j = 0; j < M; j++) {
          const cx = (i + 0.5) / 2;
          const cy = (j + 0.5) / 2;
          flipDir(tab, N, f, cx, cy, pole, b);
          fromFace(f, cx, cy, N, d);
          faceJacobian(f, d[0], d[1], d[2], N, J);
          const r0 = poleRing(tab, N, f, cx, cy, pole);
          const r1 = poleRing(tab, N, f, cx + 1e-4 * b[0], cy + 1e-4 * b[1], pole);
          if (r0 > 0.02 && r0 < 0.98) expect(r1).toBeGreaterThan(r0);
        }
      }
    }
  });

  it("displaces continuously across every cube edge and at the corners: either chart gives one height", () => {
    const r = rng(11);
    const pf = [0, 0];
    const pg = [0, 0];
    const qf = [0, 0];
    const qg = [0, 0];
    let lifted = 0;
    let carded = 0;
    for (let f = 0; f < 6; f++) {
      for (let s = 0; s < 4; s++) {
        const t = T[f * 4 + s];
        for (let n = 0; n < 160; n++) {
          // Along the whole edge, its two ends (the cube corners) included.
          const along = n < 8 ? (n % 2 ? N - 1e-3 * r() : 1e-3 * r()) : r() * N;
          const e = [
            [N, along],
            [0, along],
            [along, N],
            [along, 0],
          ][s];
          pf[0] = e[0];
          pf[1] = e[1];
          turn(pf[0], pf[1], t.k, pg);
          pg[0] += t.tx;
          pg[1] += t.ty;
          warpPoint(pf[0], pf[1], qf);
          warpPoint(pg[0], pg[1], qg);
          const hf = tileRelief(tab, N, f, qf[0], qf[1], music);
          const hg = tileRelief(tab, N, t.g, qg[0], qg[1], music);
          expect(hf).toBeCloseTo(hg, 9);
          if (hf > music.relief * 0.08) lifted++;
          const ring = poleRing(tab, N, f, qf[0], qf[1], pole);
          if (Math.abs(ring - music.front) < music.width / 2) carded++;
        }
      }
    }
    // The checks ran over lifted tiles and turning cards, not just the bare groove.
    expect(lifted).toBeGreaterThan(200);
    expect(carded).toBeGreaterThan(100);
  });

  it("is the engine's height on a face (tess.glsl tessPlate): the block, the lift, the card", () => {
    // A flat music state: no lift, no card, no pop; the block alone, at the tile's centre and outline.
    const flat = { ...music, liftAt: () => 0, front: -1, pops: [] };
    const cx = 1.25;
    const cy = 1.75;
    expect(tileRelief(tab, N, 4, cx, cy, flat)).toBeCloseTo(flat.relief * RELIEF_BLOCK * reliefProfile(0.25, flat.profile), 12);
    expect(tileRelief(tab, N, 4, 1.0 + 1e-9, cy, flat)).toBeCloseTo(0, 6);
    // Lift: a ring's lift × the tile's own 1 ± LIFT_VARY, hashed from its key.
    const lift = { ...flat, liftAt: () => 0.1 };
    tileKey(tab, N, 4, cx, cy, key);
    const vary = 1 - LIFT_VARY + 2 * LIFT_VARY * hash12(key[0] * 0.731 + 3.7, key[1] * 0.731 + 3.7);
    expect(tileRelief(tab, N, 4, cx, cy, lift) - tileRelief(tab, N, 4, cx, cy, flat)).toBeCloseTo(lift.relief * 0.1 * vary, 12);
  });
});
