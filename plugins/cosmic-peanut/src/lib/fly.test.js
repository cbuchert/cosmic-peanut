// @ts-check
import { describe, expect, it } from "vitest";
import { createBeat } from "./beat.js";
import { FLY_FOV, LOOK_RATE, NOMINAL_SPEED, SURGE, createFly } from "./fly.js";
import { GENTLE } from "./motion.js";

const dt = 1 / 60;

/** A pointer event. @param {"down" | "move" | "up"} kind @param {number} x @param {number} y */
const ptr = (kind, x, y) => ({ kind, x, y, dx: 0, dy: 0 });

describe("createFly", () => {
  it("wanders along a gently curving path: heading varies, but turns slowly and never jerks", () => {
    const fly = createFly();
    let yawLo = Infinity;
    let yawHi = -Infinity;
    let pitchHi = 0;
    let prevYaw = fly.yaw;
    let prevPitch = fly.pitch;
    let prevRate = NaN;
    let maxRate = 0;
    let maxJerk = 0;
    for (let f = 0; f < 60 * 600; f++) {
      fly.update(dt, NOMINAL_SPEED, 0, 0);
      const rate = Math.hypot(fly.yaw - prevYaw, fly.pitch - prevPitch) / dt;
      maxRate = Math.max(maxRate, rate);
      if (!Number.isNaN(prevRate)) maxJerk = Math.max(maxJerk, Math.abs(rate - prevRate) / dt);
      prevRate = rate;
      prevYaw = fly.yaw;
      prevPitch = fly.pitch;
      yawLo = Math.min(yawLo, fly.yaw);
      yawHi = Math.max(yawHi, fly.yaw);
      pitchHi = Math.max(pitchHi, Math.abs(fly.pitch));
    }
    expect(yawHi - yawLo).toBeGreaterThan(1.5); // it really does turn
    expect(pitchHi).toBeGreaterThan(0.05);
    expect(pitchHi).toBeLessThan(0.3); // never steep
    expect(maxRate).toBeLessThan(0.25); // rad/s
    expect(maxJerk).toBeLessThan(0.1); // rad/s², no sudden change of turn
  });

  it("moves along the path heading at the base speed", () => {
    const fly = createFly();
    for (let f = 0; f < 600; f++) {
      const p0 = Array.from(fly.pos);
      fly.update(dt, 2, 0, 0);
      const d = [0, 1, 2].map((i) => fly.pos[i] - p0[i]);
      expect(Math.hypot(...d)).toBeCloseTo(2 * dt, 9);
      const fwd = [Math.sin(fly.yaw) * Math.cos(fly.pitch), Math.sin(fly.pitch), -Math.cos(fly.yaw) * Math.cos(fly.pitch)];
      const along = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / (2 * dt);
      expect(along).toBeGreaterThan(0.9999);
    }
  });

  it("surges forward on the beat, eased by the beat envelope, without bending the path", () => {
    const fly = createFly();
    const calm = createFly();
    const beat = createBeat();
    const base = 1.5;
    let hi = 0;
    let lo = Infinity;
    let maxStep = 0;
    let prev = base;
    for (let f = 0; f < 60 * 4; f++) {
      const t = f / 60;
      beat.step({ bpm: 120, beatPhase: (t * 2) % 1, onset: false, onsetStrength: 0 }, dt);
      fly.update(dt, base, beat.env, 1);
      calm.update(dt, base, beat.env, 0);
      expect(fly.speed).toBeCloseTo(base * (1 + SURGE * beat.env), 9);
      expect(calm.speed).toBe(base);
      expect(fly.yaw).toBe(calm.yaw); // the surge speeds the flight, not the turning
      if (f > 30) {
        hi = Math.max(hi, fly.speed);
        lo = Math.min(lo, fly.speed);
      }
      maxStep = Math.max(maxStep, Math.abs(fly.speed - prev));
      prev = fly.speed;
    }
    expect(hi).toBeCloseTo(base * (1 + SURGE), 2);
    expect(lo).toBeCloseTo(base, 2);
    // The envelope's 80 ms smoothstep: never more than about a third of the surge in one frame.
    expect(maxStep).toBeLessThan(0.33 * SURGE * base);
  });

  it("with Reduce motion's gentle speed, drifts as much slower as it flies, and never surges", () => {
    const slow = createFly();
    const fast = createFly();
    const T = 120;
    for (let f = 0; f < 60 * T; f++) slow.update(dt, GENTLE.speed, 1, GENTLE.surge);
    const ratio = GENTLE.speed / NOMINAL_SPEED;
    expect(ratio).toBeLessThan(0.25); // a lot slower
    for (let f = 0; f < 60 * T * ratio; f++) fast.update(dt, NOMINAL_SPEED, 0, 0);
    // Same stretch of path covered: same heading, with turns a fraction as fast.
    expect(slow.yaw).toBeCloseTo(fast.yaw, 2);
    expect(slow.pitch).toBeCloseTo(fast.pitch, 2);
    expect(slow.speed).toBe(GENTLE.speed);
  });

  it("looks around while dragged, then eases back to the path heading without a jolt", () => {
    const fly = createFly();
    fly.update(dt, 1, 0, 0);
    fly.pointer(ptr("down", 100, 100));
    fly.pointer(ptr("move", 300, 50));
    // Grab the scene: dragging right turns the view left, dragging up tilts it down.
    expect(fly.lookYaw).toBeCloseTo(-200 * LOOK_RATE, 9);
    expect(fly.lookPitch).toBeCloseTo(-50 * LOOK_RATE, 9);
    for (let f = 0; f < 120; f++) fly.update(dt, 1, 0, 0);
    expect(fly.lookYaw).toBeCloseTo(-200 * LOOK_RATE, 9); // held while the pointer is down
    fly.pointer(ptr("up", 300, 50));
    const x0 = fly.lookYaw;
    let prev = x0;
    let prevStep = 0;
    let maxStep = 0;
    for (let f = 0; f < 60 * 4; f++) {
      fly.update(dt, 1, 0, 0);
      const x = fly.lookYaw;
      expect(Math.sign(x)).toBe(Math.sign(x0)); // no overshoot
      expect(Math.abs(x)).toBeLessThanOrEqual(Math.abs(prev)); // only ever heads home
      const step = Math.abs(x - prev);
      if (f === 0) expect(step).toBeLessThan(0.01 * Math.abs(x0)); // starts from rest
      maxStep = Math.max(maxStep, Math.abs(step - prevStep));
      prevStep = step;
      prev = x;
    }
    expect(maxStep).toBeLessThan(0.01 * Math.abs(x0)); // velocity changes smoothly throughout
    expect(Math.abs(fly.lookYaw)).toBeLessThan(0.01 * Math.abs(x0));
    expect(Math.abs(fly.lookPitch)).toBeLessThan(0.01 * 50 * LOOK_RATE);
  });

  it("writes a perspective and a rotation-only view (camera at the origin of the offsets) in place", () => {
    const fly = createFly();
    const { proj, view } = fly;
    for (let f = 0; f < 600; f++) fly.update(dt, 1.4, 0, 0);
    fly.pointer(ptr("down", 0, 0));
    fly.pointer(ptr("move", 40, -30));
    fly.writeMatrices(16 / 9, 20);
    expect(fly.proj).toBe(proj);
    expect(fly.view).toBe(view);
    expect(proj[5]).toBeCloseTo(1 / Math.tan(FLY_FOV / 2), 6);
    expect(proj[0]).toBeCloseTo(proj[5] / (16 / 9), 6);
    expect(fly.tanY).toBeCloseTo(Math.tan(FLY_FOV / 2), 6);
    expect(fly.tanX).toBeCloseTo(fly.tanY * (16 / 9), 6);
    const yaw = fly.yaw + fly.lookYaw;
    const pitch = fly.pitch + fly.lookPitch;
    const fwd = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    // The look direction maps to −z; the right axis stays level; no translation.
    const vz = [0, 1, 2].map((r) => view[r] * fwd[0] + view[4 + r] * fwd[1] + view[8 + r] * fwd[2]);
    expect(vz[0]).toBeCloseTo(0, 6);
    expect(vz[1]).toBeCloseTo(0, 6);
    expect(vz[2]).toBeCloseTo(-1, 6);
    expect(view[4]).toBeCloseTo(0, 6);
    expect([view[12], view[13], view[14], view[15]]).toEqual([0, 0, 0, 1]);
  });
});

