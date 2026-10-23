// @ts-check
import { describe, expect, it } from "vitest";
import { createBeat } from "./lattice-beat.js";
import { flySpeed } from "./lattice.js";
import { createSpongeCamera } from "./sponge-camera.js";
import { SPONGE_F, rebasePoint, spongeClearance } from "./structure-sponge.js";

const HZ = 240;
/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("createSpongeCamera: the endless zoom", () => {
  it("rebases into each smaller tunnel, and the flight is continuous across every rebase", () => {
    const cam = createSpongeCamera(7);
    const prev = new Float64Array(3);
    const mapped = new Float64Array(3);
    const prevFwd = new Float64Array(3);
    let depth = cam.depth;
    let rebases = 0;
    let worstGap = 0;
    let worstTurn = 0;
    for (let f = 0; f < HZ * 60; f++) {
      prev.set(cam.pos);
      prevFwd.set(cam.view.fwd);
      const scale = cam.scale;
      cam.update(1 / HZ, 1.5);
      // The previous position, carried into the current frame.
      rebasePoint(prev, cam.depth - depth, mapped);
      if (cam.depth !== depth) rebases++;
      const step = Math.hypot(cam.pos[0] - mapped[0], cam.pos[1] - mapped[1], cam.pos[2] - mapped[2]);
      // Frame cells moved, against the expected step (speed × local scale × dt).
      worstGap = Math.max(worstGap, step / ((1.5 * scale * 3 ** (cam.depth - depth)) / HZ));
      worstTurn = Math.max(worstTurn, Math.acos(Math.min(1, dot(prevFwd, cam.view.fwd))) * HZ);
      depth = cam.depth;
    }
    expect(rebases).toBeGreaterThanOrEqual(5);
    expect(worstGap).toBeLessThan(1.1);
    // The view never jumps (a rebase is a pure scaling about F: directions don't change).
    expect(worstTurn).toBeLessThan(1.6);
  });

  it("stays bounded over 10 minutes: positions near F, local scale in range, everything finite", () => {
    const cam = createSpongeCamera(42);
    let far = 0;
    let lo = Infinity;
    let hi = 0;
    let clear = Infinity;
    for (let f = 0; f < 60 * 600; f++) {
      cam.update(1 / 60, f % 120 < 10 ? 2.5 : 1);
      if (f % 7 === 0) cam.beat();
      far = Math.max(far, Math.hypot(cam.pos[0] - SPONGE_F[0], cam.pos[1] - SPONGE_F[1], cam.pos[2] - SPONGE_F[2]));
      lo = Math.min(lo, cam.scale);
      hi = Math.max(hi, cam.scale);
      clear = Math.min(clear, spongeClearance(cam.pos));
      for (const v of [cam.pos, cam.view.fwd, cam.view.up]) for (const x of v) expect(Number.isFinite(x)).toBe(true);
    }
    expect(cam.depth).toBeGreaterThan(40);
    expect(far).toBeLessThan(12);
    expect(lo).toBeGreaterThan(0.3);
    expect(hi).toBeLessThan(3.5);
    expect(clear).toBeGreaterThan(0.15);
  });

  it("keeps an orthonormal view basis", () => {
    const cam = createSpongeCamera(3);
    for (let f = 0; f < HZ * 30; f++) {
      cam.update(1 / HZ, 2);
      if (f % 100 === 0) cam.beat();
      const { fwd, up, right } = cam.view;
      expect(Math.abs(dot(fwd, fwd) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(dot(up, up) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(dot(fwd, up))).toBeLessThan(1e-9);
      expect(Math.abs(dot(fwd, right))).toBeLessThan(1e-9);
    }
  });

  it("finds the point the camera will reach a given number of local cells on", () => {
    const out = new Float64Array(3);
    const mapped = new Float64Array(3);
    for (let k = 1; k <= 20; k++) {
      const a = createSpongeCamera(11);
      a.update(0.37 * k, 1);
      a.ahead(1.6, out);
      const depth = a.depth;
      const c = createSpongeCamera(11);
      c.update(0.37 * k, 1);
      // Fly on by 1.6 local cells (speed 1: 1.6 s), in small steps.
      for (let i = 0; i < 160; i++) c.update(0.01, 1);
      rebasePoint(c.pos, depth - c.depth, mapped);
      expect(Math.hypot(out[0] - mapped[0], out[1] - mapped[1], out[2] - mapped[2]) / a.scale).toBeLessThan(0.1);
    }
  });
});

/**
 * 60 s through the entry's chain at 120 BPM (or silence): the beat envelope → flySpeed → update,
 * a beat call on every beat. Records the worst angular velocity and acceleration of the view, and
 * the worst acceleration along the path in local cells/s².
 * @param {number} bpm
 */
function beatRun(bpm) {
  const cam = createSpongeCamera(0x1a77);
  const beat = createBeat();
  const a = { bpm, beatPhase: 0, onset: false, onsetStrength: 0 };
  const f0 = Float64Array.from(cam.view.fwd);
  const p0 = Float64Array.from(cam.pos);
  const mapped = new Float64Array(3);
  let depth = cam.depth;
  let w0 = -1;
  let v0 = -1;
  const worst = { w: 0, wacc: 0, acc: 0 };
  for (let tick = 1; tick <= 3600; tick++) {
    const dt = 1 / 60;
    a.beatPhase = bpm > 0 ? ((tick / 60) * bpm) / 60 % 1 : 0;
    beat.step(a, dt);
    if (beat.beat) cam.beat();
    const scale = cam.scale;
    cam.update(dt, flySpeed(1, beat.env, 1, false));
    rebasePoint(p0, cam.depth - depth, mapped);
    const v = Math.hypot(cam.pos[0] - mapped[0], cam.pos[1] - mapped[1], cam.pos[2] - mapped[2]) / dt / (scale * 3 ** (cam.depth - depth));
    if (v0 >= 0) worst.acc = Math.max(worst.acc, Math.abs(v - v0) / dt);
    v0 = v;
    const w = Math.acos(Math.min(1, dot(f0, cam.view.fwd))) / dt;
    worst.w = Math.max(worst.w, w);
    if (w0 >= 0) worst.wacc = Math.max(worst.wacc, Math.abs(w - w0) / dt);
    w0 = w;
    f0.set(cam.view.fwd);
    p0.set(cam.pos);
    depth = cam.depth;
  }
  return { worst, cam };
}

describe("createSpongeCamera smoothness and beat turns", () => {
  it("surges smoothly and turns gently over a 120 BPM run", () => {
    const { worst } = beatRun(120);
    expect(worst.acc).toBeLessThan(1.5);
    expect(worst.w).toBeLessThan(1.6);
    expect(worst.wacc).toBeLessThan(4);
  });

  it("turns into side tunnels only when beats ask; in silence it swerves straight on", () => {
    const beats = beatRun(120).cam;
    expect(beats.beatTurns).toBeGreaterThanOrEqual(2);
    const silent = beatRun(0).cam;
    expect(silent.beatTurns).toBe(0);
    expect(silent.idleTurns).toBeGreaterThanOrEqual(3);
  });
});
