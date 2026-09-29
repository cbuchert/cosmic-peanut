// @ts-check
import { describe, expect, it } from "vitest";
import { createFollower, createSpring, createTumble, quarterStats, tetraVertices } from "./tetra-motion.js";

describe("quarterStats", () => {
  it("splits the waveform into four consecutive quarters: RMS and absolute peak of each", () => {
    const w = new Float32Array(2048);
    for (let i = 0; i < 512; i++) w[i] = 0.5; // quarter 0: DC 0.5
    for (let i = 512; i < 1024; i++) w[i] = i % 2 ? 0.25 : -0.25; // quarter 1: ±0.25
    w[1500] = -0.9; // quarter 2: one spike
    const rms = new Float32Array(4);
    const peak = new Float32Array(4);
    quarterStats(w, rms, peak);
    expect(rms[0]).toBeCloseTo(0.5, 6);
    expect(rms[1]).toBeCloseTo(0.25, 6);
    expect(rms[2]).toBeCloseTo(0.9 / Math.sqrt(512), 6);
    expect(rms[3]).toBe(0);
    expect([...peak].map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.25, 0.9, 0]);
  });

  it("handles lengths other than 2,048 (the remainder goes to the last quarter) and empty input", () => {
    const rms = new Float32Array(4);
    const peak = new Float32Array(4);
    const w = new Float32Array(1027); // quarters of 256, last one 259
    w[1026] = 0.8; // the very last sample belongs to ball 3
    w[255] = 0.3; // last sample of quarter 0
    w[256] = 0.6; // first sample of quarter 1
    quarterStats(w, rms, peak);
    expect([...peak].map((v) => Math.round(v * 100) / 100)).toEqual([0.3, 0.6, 0, 0.8]);
    expect(rms[3]).toBeCloseTo(0.8 / Math.sqrt(259), 6);
    quarterStats(new Float32Array(0), rms, peak);
    expect([...rms, ...peak].every((v) => v === 0)).toBe(true);
  });
});

describe("createFollower", () => {
  it("attacks fast and releases slowly, the same at 60 and 120 Hz", () => {
    /** @type {number[]} */
    const at = [];
    for (const hz of [60, 120]) {
      const f = createFollower(0.03, 0.3);
      let v = 0;
      for (let i = 0; i < Math.round(hz * 0.05); i++) v = f.step(1, 1 / hz); // 50 ms of signal
      const up = v;
      for (let i = 0; i < Math.round(hz * 0.1); i++) v = f.step(0, 1 / hz); // 100 ms of silence
      at.push(up, v);
    }
    expect(at[0]).toBeGreaterThan(0.75); // most of the way up in 50 ms
    expect(at[1]).toBeGreaterThan(0.5); // still well up 100 ms later
    expect(at[1]).toBeLessThan(at[0]);
    expect(at[2]).toBeCloseTo(at[0], 6);
    expect(at[3]).toBeCloseTo(at[1], 6);
  });

  it("is bounded to 0..max whatever it is fed", () => {
    const f = createFollower(0.01, 0.1, 1);
    for (const x of [50, 1e9, Infinity, -3, NaN]) {
      const v = f.step(x, 1 / 60);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("createSpring", () => {
  /** Offsets sampled every 50 ms for 3 s after a kick, at a given frame rate. */
  const kicked = (/** @type {number} */ hz) => {
    const s = createSpring(3, 0.3, 1);
    s.kick(4);
    /** @type {number[]} */
    const out = [];
    const per = hz / 20;
    for (let i = 0; i < hz * 3; i++) {
      s.step(0, 1 / hz);
      if ((i + 1) % per === 0) out.push(s.value);
    }
    return out;
  };

  it("impulse response rises, overshoots back through rest, then settles", () => {
    const x = kicked(60);
    const top = Math.max(...x);
    expect(top).toBeGreaterThan(0.1);
    expect(x.indexOf(top)).toBeLessThan(3); // peak within 150 ms
    expect(Math.min(...x)).toBeLessThan(-0.02); // rebound past rest
    expect(Math.abs(x[x.length - 1])).toBeLessThan(0.01);
  });

  it("follows a step in the target with overshoot, and matches at 60 and 120 Hz", () => {
    const s = createSpring(3, 0.3, 1);
    let top = 0;
    for (let i = 0; i < 180; i++) top = Math.max(top, s.step(0.5, 1 / 60));
    expect(top).toBeGreaterThan(0.55);
    expect(s.value).toBeCloseTo(0.5, 2);
    const a = kicked(60);
    const b = kicked(120);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4);
  });

  it("keeps the offset bounded however hard it is kicked", () => {
    const s = createSpring(3, 0.3, 1);
    for (let i = 0; i < 600; i++) {
      if (i % 5 === 0) s.kick(1e6);
      s.step(1e6, 1 / 60);
      expect(Math.abs(s.value)).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s.velocity)).toBe(true);
    }
  });
});

describe("tetraVertices", () => {
  it("is a regular tetrahedron: unit circumradius, centroid at the origin, six equal edges", () => {
    const v = tetraVertices(new Float32Array(12));
    const c = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2])).toBeCloseTo(1, 6);
      for (let k = 0; k < 3; k++) c[k] += v[i * 3 + k] / 4;
    }
    for (const x of c) expect(x).toBeCloseTo(0, 6);
    /** @type {number[]} */
    const edges = [];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        edges.push(Math.hypot(v[i * 3] - v[j * 3], v[i * 3 + 1] - v[j * 3 + 1], v[i * 3 + 2] - v[j * 3 + 2]));
    expect(edges).toHaveLength(6);
    for (const e of edges) expect(e).toBeCloseTo(Math.sqrt(8 / 3), 5);
  });
});

describe("createTumble", () => {
  /** Rotation angle between two unit quaternions. */
  const angle = (/** @type {ArrayLike<number>} */ a, /** @type {ArrayLike<number>} */ b) =>
    2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

  it("stays a unit quaternion and turns smoothly at the requested rate (rad/s)", () => {
    const t = createTumble();
    const prev = new Float64Array(4);
    let total = 0;
    for (let i = 0; i < 60 * 60; i++) {
      prev.set(t.q);
      t.step(1 / 60, 0.4, false, 0);
      const q = t.q;
      expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 9);
      const a = angle(prev, q);
      expect(a).toBeLessThanOrEqual(0.4 / 60 + 1e-6); // no jumps
      total += a;
    }
    expect(total).toBeGreaterThan(0.4 * 60 * 0.9);
    const still = createTumble();
    for (let i = 0; i < 100; i++) still.step(1 / 60, 0, false, 0);
    expect(angle(still.q, [0, 0, 0, 1])).toBeCloseTo(0, 9);
  });

  it("a beat kicks the spin up briefly; it springs back to the base rate", () => {
    const t = createTumble();
    for (let i = 0; i < 60; i++) t.step(1 / 60, 0.3, false, 0);
    expect(t.rate).toBeCloseTo(0.3, 6);
    t.step(1 / 60, 0.3, true, 1);
    let top = 0;
    for (let i = 0; i < 30; i++) top = Math.max(top, t.step(1 / 60, 0.3, false, 0));
    expect(top).toBeGreaterThan(0.45);
    expect(top).toBeLessThan(0.3 + 2); // bounded kick
    for (let i = 0; i < 180; i++) t.step(1 / 60, 0.3, false, 0);
    expect(t.rate).toBeCloseTo(0.3, 2);
  });

  it("writes a column-major orthonormal 3x3 rotation matrix", () => {
    const t = createTumble();
    for (let i = 0; i < 97; i++) t.step(1 / 60, 1.3, i % 20 === 0, 0.8);
    const m = t.matrix(new Float32Array(9));
    for (let c = 0; c < 3; c++) {
      expect(Math.hypot(m[c * 3], m[c * 3 + 1], m[c * 3 + 2])).toBeCloseTo(1, 5);
      const d = (c + 1) % 3;
      expect(m[c * 3] * m[d * 3] + m[c * 3 + 1] * m[d * 3 + 1] + m[c * 3 + 2] * m[d * 3 + 2]).toBeCloseTo(0, 5);
    }
    // det = +1: a rotation, not a reflection
    const det =
      m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2]);
    expect(det).toBeCloseTo(1, 5);
  });
});
