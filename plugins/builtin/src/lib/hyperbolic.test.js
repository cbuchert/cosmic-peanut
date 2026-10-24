// @ts-check
import { describe, expect, it } from "vitest";
import {
  createDrift,
  createIsometry,
  fold,
  foldElement,
  hypDist,
  mobiusApply,
  mobiusCompose,
  mobiusRotate,
  mobiusTranslate,
  tiling,
} from "./hyperbolic.js";

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
/** A random point in the disk with |z| < rmax. @param {number} rmax */
const inDisk = (rmax) => {
  const r = Math.sqrt(rnd()) * rmax;
  const a = rnd() * 2 * Math.PI;
  return [r * Math.cos(a), r * Math.sin(a)];
};
const out = new Float64Array(2);
const out2 = new Float64Array(2);

describe("Möbius isometries of the Poincaré disk", () => {
  it("translations and rotations, and their compositions, keep the disk and hyperbolic distances", () => {
    const m = createIsometry();
    const step = createIsometry();
    for (let k = 0; k < 5; k++) {
      const [tx, ty] = inDisk(0.7);
      mobiusTranslate(step, tx, ty);
      mobiusCompose(m, step, m);
      mobiusRotate(step, rnd() * 6);
      mobiusCompose(m, m, step);
    }
    for (let i = 0; i < 200; i++) {
      const [x1, y1] = inDisk(0.95);
      const [x2, y2] = inDisk(0.95);
      mobiusApply(m, x1, y1, out);
      mobiusApply(m, x2, y2, out2);
      expect(Math.hypot(out[0], out[1])).toBeLessThan(1);
      expect(hypDist(out[0], out[1], out2[0], out2[1])).toBeCloseTo(hypDist(x1, y1, x2, y2), 6);
      // The rim maps to the rim.
      const a = rnd() * 6.3;
      mobiusApply(m, Math.cos(a), Math.sin(a), out);
      expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 9);
    }
  });

  it("a translation by t sends 0 to t", () => {
    const m = createIsometry();
    mobiusTranslate(m, 0.3, -0.4);
    mobiusApply(m, 0, 0, out);
    expect(out[0]).toBeCloseTo(0.3, 12);
    expect(out[1]).toBeCloseTo(-0.4, 12);
  });
});

describe("{p,q} tiling fold", () => {
  const f = new Float64Array(3);
  const f2 = new Float64Array(3);

  it("builds the fundamental triangle: a geodesic ⟂ the rim meeting the sector edge at π/q", () => {
    for (const [p, q] of [[7, 3], [5, 4], [4, 5]]) {
      const t = tiling(p, q);
      expect(t.cx * t.cx).toBeCloseTo(t.r * t.r + 1, 12); // orthogonal to the unit circle
      // Angle between the line at angle α and circle C: cos φ = cx sin α / r.
      expect(Math.acos((t.cx * Math.sin(Math.PI / p)) / t.r)).toBeCloseTo(Math.PI / q, 12);
    }
  });

  it("maps any point of the disk into the fundamental domain", () => {
    for (const [p, q] of [[7, 3], [5, 4], [4, 5]]) {
      const t = tiling(p, q);
      for (let i = 0; i < 500; i++) {
        const [x, y] = inDisk(0.995);
        fold(x, y, t, f);
        const ang = Math.atan2(f[1], f[0]);
        expect(ang).toBeGreaterThanOrEqual(-1e-9);
        expect(ang).toBeLessThanOrEqual(Math.PI / p + 1e-9);
        expect(Math.hypot(f[0] - t.cx, f[1])).toBeGreaterThanOrEqual(t.r - 1e-9);
        expect(f[2]).toBeLessThan(80);
      }
    }
  });

  it("is invariant under the tiling's symmetries, and foldElement is the map it applied", () => {
    const t = tiling(7, 3);
    const g = createIsometry();
    const sym = createIsometry();
    for (let i = 0; i < 300; i++) {
      const [x, y] = inDisk(0.97);
      fold(x, y, t, f);
      // Inversion in the circle C, a rotation by 2α, and the mirror y → −y are symmetries.
      const dx = x - t.cx;
      const d2 = dx * dx + y * y;
      fold(t.cx + (t.r * t.r * dx) / d2, (t.r * t.r * y) / d2, t, f2);
      expect(f2[0]).toBeCloseTo(f[0], 6);
      expect(f2[1]).toBeCloseTo(f[1], 6);
      mobiusRotate(sym, (2 * Math.PI) / 7);
      mobiusApply(sym, x, y, out);
      fold(out[0], out[1], t, f2);
      expect(f2[0]).toBeCloseTo(f[0], 6);
      fold(x, -y, t, f2);
      expect(f2[1]).toBeCloseTo(f[1], 6);
      foldElement(x, y, t, g);
      mobiusApply(g, x, y, out);
      expect(out[0]).toBeCloseTo(f[0], 6);
      expect(out[1]).toBeCloseTo(f[1], 6);
    }
  });
});

describe("createDrift", () => {
  const t = tiling(7, 3);
  const f = new Float64Array(3);
  const f2 = new Float64Array(3);

  it("stays an isometry, keeps its coefficients bounded, and rebasing never changes the picture", () => {
    const raw = createDrift(t);
    const based = createDrift(t);
    for (let i = 0; i < 60 * 20; i++) {
      raw.advance(1 / 60, 0.3, 0.1);
      based.advance(1 / 60, 0.3, 0.1);
      based.rebase();
    }
    let maxCoef = 0;
    for (let k = 0; k < 8; k++) maxCoef = Math.max(maxCoef, Math.abs(based.m[k]));
    expect(maxCoef).toBeLessThan(2);
    let rawCoef = 0;
    for (let k = 0; k < 8; k++) rawCoef = Math.max(rawCoef, Math.abs(raw.m[k]));
    expect(rawCoef).toBeGreaterThan(3); // it really travelled (6 along a curving path)
    for (let i = 0; i < 100; i++) {
      const [x, y] = inDisk(0.9);
      mobiusApply(raw.m, x, y, out);
      fold(out[0], out[1], t, f);
      mobiusApply(based.m, x, y, out2);
      fold(out2[0], out2[1], t, f2);
      expect(f2[0]).toBeCloseTo(f[0], 5);
      expect(f2[1]).toBeCloseTo(f[1], 5);
      const [x2, y2] = inDisk(0.9);
      mobiusApply(based.m, x2, y2, out);
      expect(hypDist(out[0], out[1], out2[0], out2[1])).toBeCloseTo(hypDist(x2, y2, x, y), 6);
    }
  });

  /**
   * How far m is from an exact disk isometry λ·[a b; b̄ ā], |a|² − |b|² = 1, |λ| = 1: with |det| = 1
   * that is M*JM = J, J = diag(1, −1), i.e. |a|² − |c|² = 1, |d|² − |b|² = 1, āb = c̄d.
   * @param {Float64Array} m
   */
  const formError = (m) => {
    const [ar, ai, br, bi, cr, ci, dr, di] = m;
    const detR = ar * dr - ai * di - (br * cr - bi * ci);
    const detI = ar * di + ai * dr - (br * ci + bi * cr);
    return Math.max(
      Math.abs(Math.hypot(detR, detI) - 1),
      Math.abs(ar * ar + ai * ai - cr * cr - ci * ci - 1),
      Math.abs(dr * dr + di * di - br * br - bi * bi - 1),
      Math.abs(ar * br + ai * bi - (cr * dr + ci * di)), // re(āb − c̄d)
      Math.abs(ar * bi - ai * br - (cr * di - ci * dr)), // im(āb − c̄d)
    );
  };

  const nanIsInf = (/** @type {number} */ x) => (Number.isNaN(x) ? Infinity : x);

  it.each([
    ["{7,3} at 60 Hz", 7, 3, () => 1 / 60],
    ["{5,4} at 60 Hz", 5, 4, () => 1 / 60],
    ["{7,3} at 144 Hz", 7, 3, () => 1 / 144],
    ["{7,3} at 30 Hz", 7, 3, () => 1 / 30],
    ["{4,5} at a jittery 20–200 Hz", 4, 5, () => 0.005 + 0.045 * rnd()],
  ])("stays an exact, unmirrored isometry over 30,000 steps (%s), the view continuous across rebases", (_, p, q, dt) => {
    const tl = tiling(p, q);
    const drift = createDrift(tl);
    const before = createIsometry();
    const probe = [[0, 0], [0.5, 0.2], [-0.3, -0.7], [0.85, -0.1]];
    let clock = 0;
    let worstR = 0;
    let worstForm = 0;
    let worstJump = 0;
    let mirrored = 0;
    let leftDisk = -1; // first step with T(0) not well inside
    for (let i = 0; i < 30000; i++) {
      const h = dt();
      clock += h;
      // Tentacube's drift, a little faster: speed 0.1–0.3, a slowly reversing turn.
      drift.advance(h, 0.2 + 0.1 * Math.sin(clock * 0.3), 0.05 * Math.sin(clock * 0.07));
      before.set(drift.m);
      drift.rebase();
      mirrored += drift.m[8]; // the rebase never mirrors
      mobiusApply(drift.m, 0, 0, out);
      worstR = Math.max(worstR, nanIsInf(Math.hypot(out[0], out[1])));
      if (leftDisk < 0 && !(worstR < 0.9)) leftDisk = i;
      worstForm = Math.max(worstForm, nanIsInf(formError(drift.m)));
      if (i % 37 === 0) {
        // The picture (each screen point's folded tiling point) is the same before and after.
        for (const [x, y] of probe) {
          mobiusApply(before, x, y, out);
          fold(out[0], out[1], tl, f);
          mobiusApply(drift.m, x, y, out2);
          fold(out2[0], out2[1], tl, f2);
          worstJump = Math.max(worstJump, nanIsInf(Math.hypot(f2[0] - f[0], f2[1] - f[1])));
        }
      }
    }
    const seen = JSON.stringify({ mirrored, leftDisk, worstR, worstForm, worstJump });
    expect(mirrored, seen).toBe(0);
    expect(worstR, seen).toBeLessThan(0.9); // T(0) stays well inside the disk
    expect(worstForm, seen).toBeLessThan(1e-9);
    expect(worstJump, seen).toBeLessThan(1e-6);
  });

  it("moves the view at the requested hyperbolic speed", () => {
    const probe = createDrift(t);
    for (let i = 0; i < 60; i++) probe.advance(1 / 60, 0.3, 0);
    mobiusApply(probe.m, 0, 0, out2); // where the view centre is now, in the tiling
    expect(hypDist(0, 0, out2[0], out2[1])).toBeCloseTo(0.3, 6);
  });
});
