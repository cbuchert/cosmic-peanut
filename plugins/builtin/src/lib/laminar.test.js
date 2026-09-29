// @ts-check
import { describe, expect, it } from "vitest";
import { createDrift, createLoudness, createPulse, DRIFT_REGION, flowDrive, PULSE_MAX, RE_MAX, RE_MIN } from "./laminar.js";

/** A minimal audio frame. @param {number} rms @param {Partial<Record<string, any>>} [more] */
const frame = (rms, more = {}) => ({ rms, silent: rms === 0, bassAtt: 1, bass: 1, onset: false, onsetStrength: 0, ...more });

/** Loudness after `s` seconds of a steady level. @param {number} rms @param {number} s */
function settle(rms, s = 4, hz = 60) {
  const l = createLoudness();
  for (let f = 0; f < s * hz; f++) l.step(frame(rms), 1 / hz);
  return l.value;
}

describe("createLoudness", () => {
  it("is 0 in silence, rises with the level, stays within 0–1 and saturates for loud music", () => {
    expect(settle(0)).toBe(0);
    let prev = -1;
    for (const rms of [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4]) {
      const v = settle(rms);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(settle(0.3)).toBeGreaterThan(0.9);
    expect(settle(0.01)).toBeLessThan(0.3);
  });

  it("reads a quiet passage after a loud one as quiet, glides (no jumps) and behaves the same at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const run = (hz) => {
      const l = createLoudness();
      let maxJump = 0;
      let prev = 0;
      /** @type {number[]} */ const at = [];
      for (let f = 0; f < hz * 10; f++) {
        const t = f / hz;
        l.step(frame(t < 5 ? 0.3 : 0.06), 1 / hz);
        maxJump = Math.max(maxJump, Math.abs(l.value - prev));
        prev = l.value;
        if ((f + 1) % (hz / 2) === 0) at.push(l.value);
      }
      return { at, maxJump, end: l.value };
    };
    const a = run(60);
    const b = run(120);
    expect(a.end).toBeLessThan(settle(0.06) * 0.8); // the reference remembers the loud part
    expect(a.end).toBeLessThan(0.5);
    expect(a.maxJump).toBeLessThan(0.15);
    for (let i = 0; i < a.at.length; i++) expect(a.at[i]).toBeCloseTo(b.at[i], 2);
  });
});

describe("flowDrive", () => {
  const out = { inflow: 0, re: 0, nu: 0, vort: 0 };
  const D = 0.2; // sphere diameter, screen heights

  it("loudness raises the Reynolds number and the inflow speed and lowers the viscosity, monotonically and within bounds", () => {
    let prev = { inflow: 0, re: 0, nu: Infinity, vort: -1 };
    for (let i = 0; i <= 20; i++) {
      flowDrive(i / 20, 1, 1, 1, D, out);
      expect(out.re).toBeGreaterThan(prev.re);
      expect(out.inflow).toBeGreaterThan(prev.inflow);
      expect(out.nu).toBeLessThan(prev.nu);
      expect(out.vort).toBeGreaterThan(prev.vort);
      expect(out.nu).toBeCloseTo((out.inflow * D) / out.re, 12); // Re = U·D / ν
      expect(out.re).toBeGreaterThanOrEqual(RE_MIN);
      expect(out.re).toBeLessThanOrEqual(RE_MAX);
      prev = { ...out };
    }
    flowDrive(0, 1, 1, 1, D, out);
    const quiet = out.re;
    flowDrive(1, 1, 1, 1, D, out);
    expect(out.re / quiet).toBeGreaterThan(20); // calm vs. chaos, not a nudge
  });

  it("Reactivity 0 ignores the music; Turbulence scales Re (and confinement) up; Flow speed scales the inflow", () => {
    flowDrive(0, 0, 1, 1, D, out);
    const a = { ...out };
    flowDrive(1, 0, 1, 1, D, out);
    expect(out).toEqual(a);
    let prev = 0;
    for (const t of [0, 0.5, 1, 1.5, 2, 5]) {
      flowDrive(0.5, 1, 1, t, D, out);
      expect(out.re).toBeGreaterThanOrEqual(prev);
      prev = out.re;
    }
    expect(prev).toBeLessThanOrEqual(RE_MAX);
    flowDrive(0.5, 1, 2, 1, D, out);
    const fast = out.inflow;
    flowDrive(0.5, 1, 1, 1, D, out);
    expect(fast).toBeCloseTo(2 * out.inflow, 12);
    flowDrive(0.5, 1, -1, 1, D, out);
    expect(out.inflow).toBe(0);
    expect(Number.isFinite(out.nu)).toBe(true);
  });
});

describe("createPulse", () => {
  it("swells the sphere with the bass, within 1 … 1 + PULSE_MAX, smoothly, and reports its growth rate", () => {
    const p = createPulse();
    const dt = 1 / 60;
    let prev = 1;
    let lo = Infinity;
    let hi = 0;
    for (let f = 0; f < 600; f++) {
      const bassAtt = f % 30 < 3 ? 50 : 0; // violent kicks, silence between
      p.step(bassAtt, dt, 2);
      expect(p.scale).toBeGreaterThanOrEqual(1);
      expect(p.scale).toBeLessThanOrEqual(1 + PULSE_MAX);
      expect(Math.abs(p.scale - prev)).toBeLessThan(PULSE_MAX * 0.25); // no one-frame pops
      expect(p.rate).toBeCloseTo((p.scale - prev) / dt, 6);
      lo = Math.min(lo, p.scale);
      hi = Math.max(hi, p.scale);
      prev = p.scale;
    }
    expect(hi - lo).toBeGreaterThan(PULSE_MAX * 0.4); // it does pulse, even on 50 ms kicks
    const heavy = createPulse();
    const light = createPulse();
    for (let f = 0; f < 120; f++) {
      heavy.step(1.6, dt, 1);
      light.step(1.0, dt, 1);
    }
    expect(heavy.scale).toBeGreaterThan(light.scale);
  });
});

describe("createDrift", () => {
  /** Inside the drift region (an ellipse around home)? @param {{ x: number, y: number }} d */
  const inside = (d) => (d.x / DRIFT_REGION[0]) ** 2 + (d.y / DRIFT_REGION[1]) ** 2 <= 1 + 1e-9;

  it("a beat nudges the sphere off home; it glides back and settles, never leaving its region", () => {
    const d = createDrift();
    const dt = 1 / 60;
    d.step(true, 1, dt, 1);
    let far = 0;
    let px = d.x;
    let py = d.y;
    for (let f = 0; f < 60 * 8; f++) {
      d.step(false, 0, dt, 1);
      expect(inside(d)).toBe(true);
      expect(Math.hypot(d.x - px, d.y - py)).toBeLessThan(0.02); // glides: no teleporting
      px = d.x;
      py = d.y;
      far = Math.max(far, Math.hypot(d.x, d.y));
    }
    expect(far).toBeGreaterThan(0.03); // the nudge is visible
    expect(Math.hypot(d.x, d.y)).toBeLessThan(1e-3); // settled
    expect(Math.hypot(d.vx, d.vy)).toBeLessThan(1e-3);
  });

  it("stays in its region under a barrage of beats, and follows the same path at 60 and 120 Hz", () => {
    /** @param {number} hz */
    const run = (hz) => {
      const d = createDrift();
      /** @type {number[]} */ const path = [];
      for (let f = 0; f < hz * 10; f++) {
        // 4 beats a second at full strength, landing on frames both rates share.
        d.step(f % (hz / 4) === 0, 1, 1 / hz, 2);
        expect(inside(d)).toBe(true);
        if ((f + 1) % (hz / 4) === 0) path.push(d.x, d.y);
      }
      return path;
    };
    const a = run(60);
    const b = run(120);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.01);
    // 12 beats a second, strength 1, Reactivity 2: still inside.
    const d = createDrift();
    for (let f = 0; f < 600; f++) {
      d.step(f % 5 === 0, 1, 1 / 60, 2);
      expect(inside(d)).toBe(true);
    }
  });
});
