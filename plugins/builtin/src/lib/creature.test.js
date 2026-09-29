// @ts-check
import { describe, expect, it } from "vitest";
import {
  cubeEdge,
  ROOT_FLARE,
  tubeRadius,
  createMorph,
  createRng,
  createSpring,
  createSurge,
  createTransient,
  createTwist,
  createTwitch,
  DEFAULT_TWITCH,
  effectiveMotion,
  PRESETS,
  pulseTarget,
  quatAngle,
} from "./creature.js";

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

describe("pulseTarget", () => {
  it("is 1 at or below average bass, swells with heavier bass, bounded, scaled by the amount", () => {
    expect(pulseTarget(0, 1)).toBe(1);
    expect(pulseTarget(1, 1)).toBe(1);
    expect(pulseTarget(1.6, 1)).toBeGreaterThan(1.1);
    expect(pulseTarget(50, 1)).toBeLessThanOrEqual(1.4);
    expect(pulseTarget(50, 2) - 1).toBeCloseTo(2 * (pulseTarget(50, 1) - 1), 9);
    expect(pulseTarget(1.6, 0)).toBe(1);
  });
});

describe("createSurge", () => {
  /** Rises that start per second of a 10 Hz beat train. @param {boolean} reduce */
  const risesPerSecond = (reduce) => {
    const s = createSurge();
    const dt = 1 / 60;
    let rises = 0;
    let prev = 0;
    let up = false;
    for (let f = 0; f < 240; f++) {
      const v = s.step(f % 6 === 0, 1, dt, reduce);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > prev + 1e-6 && !up) rises++;
      up = v > prev + 1e-6;
      prev = v;
    }
    return rises / 4;
  };

  it("jumps on a beat and decays; a 10 Hz strobe becomes at most 3 surges/s with reduceFlashing", () => {
    expect(risesPerSecond(false)).toBeGreaterThan(8);
    expect(risesPerSecond(true)).toBeLessThanOrEqual(3);
  });
});

describe("createMorph", () => {
  const dt = 1 / 60;
  /**
   * Run the sequencer; returns the times (s) a new preset became the target, and its index.
   * @param {number} seconds @param {string} morph @param {string} material
   * @param {(t: number) => number} energy @param {number} [bpm]
   */
  const run = (seconds, morph, material, energy, bpm = 120) => {
    const m = createMorph();
    /** @type {[number, number][]} */
    const switches = [];
    let last = m.target;
    let maxSlope = 0;
    const prev = Float32Array.from(m.weights);
    for (let f = 0; f < seconds * 60; f++) {
      const t = f * dt;
      m.step(dt, morph, material, energy(t), bpm);
      if (m.target !== last) switches.push([Math.round(t * 10) / 10, m.target]);
      last = m.target;
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        sum += m.weights[i];
        maxSlope = Math.max(maxSlope, Math.abs(m.weights[i] - prev[i]) / dt);
        prev[i] = m.weights[i];
      }
      expect(sum).toBeCloseTo(1, 5);
    }
    return { m, switches, maxSlope };
  };

  it("cycles chrome → iridescent → emissive → obsidian every 16 bars on slow, 4 on fast", () => {
    expect(PRESETS).toEqual(["chrome", "iridescent", "emissive", "obsidian"]);
    const slow = run(140, "slow", "auto", () => 0.3).switches;
    expect(slow.map((s) => s[1])).toEqual([1, 2, 3, 0]);
    expect(slow[0][0]).toBeCloseTo(32, 0); // 16 bars of 4 beats at 120 bpm
    expect(slow[1][0] - slow[0][0]).toBeCloseTo(32, 0);
    const fast = run(20, "fast", "auto", () => 0.3).switches;
    expect(fast.map((s) => s[0])).toEqual([8, 16]);
    const noTempo = run(40, "slow", "auto", () => 0.3, 0).switches;
    expect(noTempo[0][0]).toBeCloseTo(32, 0); // 120 bpm assumed until the tempo is known
  });

  it("crossfades smoothly over about 1.5 s", () => {
    const { m, maxSlope } = run(33, "slow", "auto", () => 0.3);
    expect(maxSlope).toBeLessThan(1.6 / 1); // smoothstep over ≥ 1 s
    expect(m.weights[0]).toBeGreaterThan(0.2); // mid-fade at 33 s
    expect(m.weights[1]).toBeGreaterThan(0.2);
    const after = run(34.5, "slow", "auto", () => 0.3).m;
    expect(after.weights[1]).toBeCloseTo(1, 5);
  });

  it("switches early on a sustained change in energy, but not on a brief spike", () => {
    const jump = run(20, "slow", "auto", (t) => (t < 10 ? 0.1 : 0.6)).switches;
    expect(jump.length).toBe(1);
    expect(jump[0][0]).toBeGreaterThan(10.5);
    expect(jump[0][0]).toBeLessThan(14);
    const spike = run(20, "slow", "auto", (t) => (t > 10 && t < 10.3 ? 0.9 : 0.1)).switches;
    expect(spike).toEqual([]);
  });

  it("never switches with morph off; a fixed material fades to that preset and stays", () => {
    expect(run(80, "off", "auto", (t) => (t < 10 ? 0.1 : 0.6)).switches).toEqual([]);
    const fixed = run(80, "fast", "emissive", (t) => (t < 10 ? 0.1 : 0.6));
    expect(fixed.switches).toEqual([[0, 2]]);
    expect(fixed.m.weights[2]).toBe(1);
  });

  it("is deterministic", () => {
    const e = (/** @type {number} */ t) => 0.3 + 0.25 * Math.sin(t * 0.37) * Math.sin(t * 1.3);
    const a = run(120, "fast", "auto", e).switches;
    expect(a.length).toBeGreaterThan(3);
    expect(a).toEqual(run(120, "fast", "auto", e).switches);
  });
});

describe("effectiveMotion", () => {
  it("calms twitch, drift and tumble under Reduce Motion while twitch is at its default", () => {
    const out = { twitch: 0, drift: 0, tumble: 0 };
    effectiveMotion(DEFAULT_TWITCH, false, out);
    expect(out).toEqual({ twitch: DEFAULT_TWITCH, drift: 1, tumble: 1 });
    effectiveMotion(DEFAULT_TWITCH, true, out);
    expect(out.twitch).toBeLessThan(DEFAULT_TWITCH * 0.5);
    expect(out.drift).toBeLessThan(0.5);
    expect(out.tumble).toBeLessThan(0.6);
    effectiveMotion(1.7, true, out); // the user chose a twitch: respect it
    expect(out.twitch).toBe(1.7);
    expect(out.drift).toBeLessThan(0.5);
  });
});

describe("cube and tentacle root sizing", () => {
  it("tube radius follows √length, clamped, like the tube shader's uRadius", () => {
    expect(tubeRadius(1)).toBeCloseTo(0.17);
    expect(tubeRadius(4)).toBeCloseTo(0.17 * 1.4);
    expect(tubeRadius(0.1)).toBeCloseTo(0.17 * 0.7);
  });
  it("each cube face is the size of a tentacle's (flared) root", () => {
    for (const len of [0.5, 1, 1.5, 2]) {
      expect(cubeEdge(len)).toBeCloseTo(2 * tubeRadius(len) * ROOT_FLARE);
    }
    expect(ROOT_FLARE).toBeCloseTo(1.35); // tube.vert: (1.0 + 0.35 * exp(-tS * 12.0)) at tS = 0
    expect(cubeEdge(1)).toBeLessThan(0.5);
  });
});
