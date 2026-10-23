// @ts-check
import { describe, expect, it } from "vitest";
import { AHEAD_CONE, AHEAD_FADE, BOX, FOG_START, INST, HUE, JITTER, NEAR, SCALE, SPIN, bandFade, createField, createLayout, fieldCount, rowLag } from "./field.js";
import { createFly } from "./fly.js";

describe("createLayout", () => {
  it("puts each band in its own cell of the smallest grid that holds them, the same for the same seed", () => {
    const a = createLayout(100, 7);
    const b = createLayout(100, 7);
    const c = createLayout(100, 8);
    expect(a.count).toBe(100);
    expect(a.n).toBe(5); // 4³ = 64 < 100 ≤ 125 = 5³
    expect(Array.from(a.unit)).toEqual(Array.from(b.unit));
    expect(Array.from(a.quat)).toEqual(Array.from(b.quat));
    expect(Array.from(a.unit)).not.toEqual(Array.from(c.unit));
    const cells = new Set();
    for (let k = 0; k < a.count; k++) {
      const cell = [0, 1, 2].map((d) => {
        const u = a.unit[k * 3 + d] * a.n;
        const i = Math.floor(u);
        expect(Math.abs(u - i - 0.5)).toBeLessThanOrEqual(JITTER + 1e-6);
        return i;
      });
      cells.add(cell.join());
    }
    expect(cells.size).toBe(100);
  });

  it("keeps every two bands at least (1 − 2·JITTER) of a cell apart, across the wrap too", () => {
    const { unit, count, n } = createLayout(200, 3);
    /** @param {number} d */
    const wrap = (d) => d - Math.round(d);
    let min = Infinity;
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const dx = wrap(unit[a * 3] - unit[b * 3]);
        const dy = wrap(unit[a * 3 + 1] - unit[b * 3 + 1]);
        const dz = wrap(unit[a * 3 + 2] - unit[b * 3 + 2]);
        min = Math.min(min, Math.hypot(dx, dy, dz));
      }
    }
    expect(min * n).toBeGreaterThanOrEqual(1 - 2 * JITTER - 1e-6);
    expect(min * n).toBeLessThan(1); // jittered, not a rigid lattice
  });

  it("gives each band its own size, slow spin, history offset, hue and wring side", () => {
    const L = createLayout(216, 11);
    let pos = 0;
    let sides = 0;
    for (let k = 0; k < L.count; k++) {
      expect(L.scale[k]).toBeGreaterThanOrEqual(SCALE[0]);
      expect(L.scale[k]).toBeLessThanOrEqual(SCALE[1]);
      expect(Math.abs(L.spin[k])).toBeGreaterThanOrEqual(SPIN[0]);
      expect(Math.abs(L.spin[k])).toBeLessThanOrEqual(SPIN[1]);
      if (L.spin[k] > 0) pos++;
      expect(L.offset[k]).toBeGreaterThanOrEqual(0);
      expect(L.offset[k]).toBeLessThan(1);
      expect(Math.abs(L.hue[k])).toBeLessThanOrEqual(HUE);
      expect(Math.abs(L.side[k])).toBe(1);
      sides += L.side[k];
      const q = L.quat.subarray(k * 4, k * 4 + 4);
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    }
    // Both spin directions and both wring sides, roughly half each.
    expect(pos / L.count).toBeGreaterThan(0.3);
    expect(pos / L.count).toBeLessThan(0.7);
    expect(Math.abs(sides) / L.count).toBeLessThan(0.3);
    // Neighbours along x show different moments of the history.
    let diff = 0;
    for (let k = 0; k < L.count - 1; k++) diff += Math.abs(L.offset[k] - L.offset[k + 1]);
    expect(diff / (L.count - 1)).toBeGreaterThan(0.2);
  });
});

describe("bandFade", () => {
  const fog = 14;
  const r = 1.4;
  it("fades a band in from black at the fog distance, and out when it gets close", () => {
    expect(bandFade(fog, r, fog)).toBe(0);
    expect(bandFade(fog + 3, r, fog)).toBe(0);
    expect(bandFade(FOG_START * fog, r, fog)).toBe(1);
    expect(bandFade(NEAR[1] * r, r, fog)).toBe(1);
    expect(bandFade(NEAR[0] * r, r, fog)).toBe(0);
    expect(bandFade(0, r, fog)).toBe(0);
    // Smooth and monotone on each side: no step anywhere a band could pop.
    let prev = 0;
    for (let d = NEAR[0] * r; d <= NEAR[1] * r; d += 0.01) {
      const f = bandFade(d, r, fog);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f - prev).toBeLessThan(0.02);
      prev = f;
    }
    for (let d = FOG_START * fog; d <= fog; d += 0.01) {
      const f = bandFade(d, r, fog);
      expect(f).toBeLessThanOrEqual(prev);
      expect(prev - f).toBeLessThan(0.02);
      prev = f;
    }
  });
});

describe("createField", () => {
  it("keeps every band within the box around the camera, wrapping only where it's faded out", () => {
    const fog = 10;
    const reach = 1.5;
    const field = createField(125, 1, fog);
    const S = 2 * BOX * fog;
    const cam = [0.3, -0.2, 0.1];
    field.place(cam, reach);
    const prev = Float32Array.from(field.rel);
    const prevFade = Float32Array.from(field.fade);
    let wraps = 0;
    for (let f = 0; f < 1500; f++) {
      const yaw = (0.4 * f) / 60;
      const step = [Math.sin(yaw) * 0.4, 0.1 * Math.sin(f / 90), -Math.cos(yaw) * 0.4];
      for (let d = 0; d < 3; d++) cam[d] += step[d];
      field.place(cam, reach);
      for (let k = 0; k < field.count; k++) {
        let jumped = false;
        for (let d = 0; d < 3; d++) {
          const r = field.rel[k * 3 + d];
          expect(Math.abs(r)).toBeLessThanOrEqual(BOX * fog + 1e-4);
          const moved = r - prev[k * 3 + d] + step[d]; // 0, or ±S on a wrap
          if (Math.abs(moved) > 1e-3) {
            expect(Math.abs(Math.abs(moved) - S)).toBeLessThan(1e-3);
            jumped = true;
          }
          prev[k * 3 + d] = r;
        }
        if (jumped) {
          wraps++;
          expect(prevFade[k]).toBe(0);
          expect(field.fade[k]).toBe(0);
        }
        const r = field.rel.subarray(k * 3, k * 3 + 3);
        expect(field.fade[k]).toBeCloseTo(bandFade(Math.hypot(...r), reach * field.layout.scale[k], fog), 5);
        prevFade[k] = field.fade[k];
      }
    }
    expect(wraps).toBeGreaterThan(100);
  });

  it("stretches about the camera when Fog changes, so nothing jumps", () => {
    const field = createField(64, 2, 8);
    const cam = [31.2, -4.5, -77.7];
    field.place(cam, 1.5);
    const before = Float32Array.from(field.rel);
    field.setFog(12, cam);
    field.place(cam, 1.5);
    for (let i = 0; i < before.length; i++) expect(field.rel[i]).toBeCloseTo(before[i] * 1.5, 4);
  });

  it("packs only the bands that are lit and in view, with their pose, size, offset, hue and side", () => {
    const fog = 12;
    const reach = 1.5;
    const field = createField(216, 5, fog);
    const cam = [3, 1, -2];
    field.place(cam, reach);
    const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // looking down −z
    const tan = 0.5;
    const rows = 30;
    const n = field.pack(view, tan, tan, reach, rows);
    let want = 0;
    const seen = new Set();
    for (let k = 0; k < field.count; k++) {
      const [x, y, z] = field.rel.subarray(k * 3, k * 3 + 3);
      const r = reach * field.layout.scale[k];
      const slack = r * Math.hypot(1, tan);
      const inView = -z > -r && Math.abs(x) <= -z * tan + slack && Math.abs(y) <= -z * tan + slack;
      if (!inView || field.fade[k] === 0) continue;
      want++;
      // Find it among the instances by its offset.
      let i = 0;
      while (i < n && field.inst[i * INST] !== x) i++;
      expect(i).toBeLessThan(n);
      seen.add(i);
      const o = i * INST;
      expect([field.inst[o + 1], field.inst[o + 2], field.inst[o + 3]]).toEqual([y, z, field.fade[k]]);
      expect(field.inst[o + 8]).toBe(field.layout.scale[k]);
      expect(field.inst[o + 9]).toBe(Math.floor(field.layout.offset[k] * rows));
      expect(field.inst[o + 10]).toBe(field.layout.hue[k]);
      expect(field.inst[o + 11]).toBe(field.layout.side[k]);
    }
    expect(n).toBe(want);
    expect(seen.size).toBe(n);
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(field.count / 4);
  });

  it("reports the nearest lit band ahead (centre near the view axis) as the focus target", () => {
    const fog = 12;
    const reach = 1.5;
    const field = createField(216, 5, fog);
    const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // looking down −z
    const tan = 0.5;
    let found = 0;
    for (const cam of [
      [3, 1, -2],
      [0, 0, 0],
      [-7, 2, 11],
      [5, -4, 1],
    ]) {
      field.place(cam, reach);
      field.pack(view, tan, tan, reach, 30);
      let want = Infinity;
      for (let k = 0; k < field.count; k++) {
        const [x, y, z] = field.rel.subarray(k * 3, k * 3 + 3);
        const depth = -z;
        if (depth <= 0 || field.fade[k] < AHEAD_FADE) continue;
        if (Math.abs(x) > depth * tan * AHEAD_CONE || Math.abs(y) > depth * tan * AHEAD_CONE) continue;
        want = Math.min(want, depth);
      }
      expect(field.ahead).toBeCloseTo(want, 5);
      if (want < Infinity) found++;
    }
    expect(found).toBeGreaterThan(1);
  });

  it("spins each band slowly about its own axis, at its own rate", () => {
    const field = createField(27, 9, 6);
    const cam = [0, 0, 0];
    field.place(cam, 0.01);
    const look = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    /** Rotate v by the unit quaternion q. @param {Float32Array} q @param {number[]} v */
    const rot = (q, v) => {
      const [x, y, z, w] = q;
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [
        v[0] + w * t[0] + y * t[2] - z * t[1],
        v[1] + w * t[1] + z * t[0] - x * t[2],
        v[2] + w * t[2] + x * t[1] - y * t[0],
      ];
    };
    /** Instance pose of band k, packed with every band in view. @param {number} k */
    const pose = (k) => {
      field.fade.fill(1);
      field.rel.fill(0);
      for (let i = 0; i < field.count; i++) field.rel[i * 3 + 2] = -3;
      field.pack(look, 10, 10, 0.01, 1);
      return field.inst.slice(k * INST + 4, k * INST + 8);
    };
    const dt = 1 / 60;
    for (let k = 0; k < field.count; k++) {
      const q0 = pose(k);
      const axis = rot(q0, [0, 1, 0]);
      const x0 = rot(q0, [1, 0, 0]);
      for (let f = 0; f < 60; f++) field.spin(dt);
      const q1 = pose(k);
      const axis1 = rot(q1, [0, 1, 0]);
      for (let d = 0; d < 3; d++) expect(axis1[d]).toBeCloseTo(axis[d], 5);
      const x1 = rot(q1, [1, 0, 0]);
      const cos = x0[0] * x1[0] + x0[1] * x1[1] + x0[2] * x1[2];
      expect(Math.acos(Math.min(1, cos))).toBeCloseTo(Math.abs(field.layout.spin[k]), 4);
      for (let f = 0; f < 60; f++) field.spin(-dt); // back to where it was for the next band
    }
  });
});


describe("fieldCount", () => {
  it("sizes the field so about Bands band centres are in view at 16:9, whatever the Fog", () => {
    for (const bands of [12, 40, 80]) {
      for (const fog of [8, 20]) {
        const field = createField(fieldCount(bands), 4, fog);
        const fly = createFly();
        let seen = 0;
        const trials = 60;
        for (let t = 0; t < trials; t++) {
          for (let f = 0; f < 120; f++) fly.update(1 / 60, 1.4 * fog, 0, 0); // somewhere new
          fly.writeMatrices(16 / 9, fog);
          field.place(fly.pos, 0.001);
          seen += field.pack(fly.view, fly.tanX, fly.tanY, 0.001, 1);
        }
        expect(seen / trials / bands).toBeGreaterThan(0.85);
        expect(seen / trials / bands).toBeLessThan(1.15);
      }
    }
    expect(fieldCount(41)).toBeGreaterThan(fieldCount(40)); // every step of the slider counts
  });
});

describe("rowLag", () => {
  it("lets a band lag up to an eighth of the history behind, leaving the rest to draw", () => {
    expect(rowLag(240)).toBe(30);
    expect(rowLag(120)).toBe(15);
    expect(rowLag(400)).toBe(50);
  });
});
