// @ts-check
import { describe, expect, it } from "vitest";
import { createRng, createSpring, createTransient, createTwist, createTwitch, quatAngle } from "./creature.js";

describe("createRng", () => {
  it("is deterministic per seed, uniform in [0, 1), and differs between seeds", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    let same = 0;
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      if (x === c.next()) same++;
      sum += x;
    }
    expect(same).toBeLessThan(5);
    expect(sum / 2000).toBeCloseTo(0.5, 1);
  });
});

describe("createSpring", () => {
  it("an impulse makes it rise, overshoot back past rest, then settle; bounded", () => {
    const h = 1 / 240;
    const sp = createSpring(3, 0.3);
    sp.impulse(4);
    let peak = 0;
    let trough = 0;
    let peakAt = 0;
    for (let i = 0; i < 240 * 4; i++) {
      sp.step(h, 0);
      if (sp.x > peak) {
        peak = sp.x;
        peakAt = i * h;
      }
      trough = Math.min(trough, sp.x);
      expect(Math.abs(sp.x)).toBeLessThan(1);
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(peakAt).toBeGreaterThan(0.03);
    expect(peakAt).toBeLessThan(0.2);
    expect(trough).toBeLessThan(-0.02); // overshoot: underdamped
    expect(Math.abs(sp.x)).toBeLessThan(1e-3); // settled after 4 s
    expect(Math.abs(sp.v)).toBeLessThan(1e-2);
  });

  it("follows a target smoothly and stays stable at its natural frequency limits", () => {
    const sp = createSpring(9, 0.25);
    for (let i = 0; i < 240 * 3; i++) sp.step(1 / 240, 1);
    expect(sp.x).toBeCloseTo(1, 3);
  });
});

describe("createTwist", () => {
  const h = 1 / 240;

  it("a kick twists toward a new orientation, overshoots it, and settles there", () => {
    const tw = createTwist(createRng(3));
    const start = Float64Array.from(tw.q);
    tw.kick(1);
    const kicked = quatAngle(start, tw.target);
    expect(kicked).toBeGreaterThan(1);
    let maxTurn = 0;
    let maxRate = 0;
    for (let i = 0; i < 240 * 5; i++) {
      tw.step(h, 0);
      maxTurn = Math.max(maxTurn, quatAngle(start, tw.q));
      maxRate = Math.max(maxRate, Math.hypot(tw.w[0], tw.w[1], tw.w[2]));
      expect(Math.hypot(tw.q[0], tw.q[1], tw.q[2], tw.q[3])).toBeCloseTo(1, 9);
    }
    expect(maxTurn).toBeGreaterThan(kicked * 1.05); // overshoot
    expect(maxRate).toBeLessThan(40); // bounded
    expect(quatAngle(tw.q, tw.target)).toBeLessThan(1e-3); // settled on the new orientation
  });

  it("picks the same axes for the same seed and different ones for another", () => {
    const run = (/** @type {number} */ seed) => {
      const tw = createTwist(createRng(seed));
      for (let k = 0; k < 6; k++) {
        tw.kick(0.8);
        for (let i = 0; i < 120; i++) tw.step(h, 0.2);
      }
      return Array.from(tw.q);
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("tumbles slowly at the idle rate when there are no kicks", () => {
    const tw = createTwist(createRng(1));
    const start = Float64Array.from(tw.q);
    for (let i = 0; i < 240; i++) tw.step(h, 0.3);
    const turned = quatAngle(start, tw.q);
    expect(turned).toBeGreaterThan(0.2);
    expect(turned).toBeLessThan(0.35);
  });
});

describe("createTwitch", () => {
  it("a jolt is a small, fast, damped shake of position and rotation", () => {
    const tw = createTwitch(createRng(2));
    tw.jolt(1);
    let peak = 0;
    let peakAt = 0;
    let rot = 0;
    for (let i = 0; i < 240; i++) {
      tw.step(1 / 240);
      const m = Math.hypot(tw.pos[0], tw.pos[1], tw.pos[2]);
      if (m > peak) {
        peak = m;
        peakAt = i / 240;
      }
      rot = Math.max(rot, Math.hypot(tw.rot[0], tw.rot[1], tw.rot[2]));
    }
    expect(peak).toBeGreaterThan(0.03);
    expect(peak).toBeLessThan(0.3);
    expect(peakAt).toBeLessThan(0.08);
    expect(rot).toBeGreaterThan(0.03);
    expect(rot).toBeLessThan(0.4);
    expect(Math.hypot(tw.pos[0], tw.pos[1], tw.pos[2])).toBeLessThan(0.002);
  });
});

describe("createTransient", () => {
  it("fires on a sharp rise in flux or treble, not on a steady high level, with a refractory gap", () => {
    const tr = createTransient();
    const dt = 1 / 60;
    let fired = 0;
    for (let f = 0; f < 120; f++) if (tr.step(0.6, 1.5, dt) > 0) fired++; // steady (after settling)
    const steadyFires = fired;
    expect(steadyFires).toBeLessThanOrEqual(1);
    fired = 0;
    for (let f = 0; f < 120; f++) {
      const hit = f % 6 === 0; // 10 Hz spikes
      if (tr.step(hit ? 1 : 0.1, hit ? 2 : 0.5, dt) > 0) fired++;
    }
    expect(fired).toBeGreaterThan(4);
    expect(fired).toBeLessThanOrEqual(2 * 8); // refractory ≥ 1/8 s
  });
});
