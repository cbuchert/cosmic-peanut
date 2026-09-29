// @ts-check
import { describe, expect, it } from "vitest";
import { BACKDROPS, MOTION_DEFAULTS, motion, REDUCED_MOTION, createGlow, GLOW_MAX, gapOpacity, PALETTES, palette, trailColor, TRAIL_OLD, createDrift, DRIFT_VMAX, createKicks, createLoudness, createPulse, DRIFT_REGION, KICK_GAP, flowDrive, PULSE_MAX, RE_MAX, RE_MIN } from "./laminar.js";

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
    for (let f = 0; f < 60 * 16; f++) {
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

  it("moves gently even under a barrage of beats: never faster than DRIFT_VMAX, so the flow isn't shaken", () => {
    expect(DRIFT_VMAX).toBeLessThanOrEqual(0.12);
    const d = createDrift();
    let far = 0;
    for (let f = 0; f < 600; f++) {
      d.step(f % 5 === 0, 1, 1 / 60, 2);
      expect(Math.hypot(d.vx, d.vy)).toBeLessThanOrEqual(DRIFT_VMAX + 1e-9);
      far = Math.max(far, Math.hypot(d.x, d.y));
    }
    expect(far).toBeGreaterThan(0.03); // but it does travel
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

describe("createKicks", () => {
  it("turns each beat into one vortex kick, delivered over a few sim steps, alternating sides", () => {
    const k = createKicks();
    const dt = 1 / 60;
    /** @type {number[]} */ const totals = [];
    let cur = 0;
    for (let f = 0; f < 240; f++) {
      k.trigger(f % 30 === 0, 0.8, 1);
      const a = k.step(dt);
      expect(Math.abs(a)).toBeLessThanOrEqual(1);
      cur += a;
      if (f % 30 === 29) {
        totals.push(cur);
        cur = 0;
      }
    }
    expect(totals.length).toBe(8);
    for (let i = 0; i < totals.length; i++) {
      expect(Math.abs(totals[i])).toBeGreaterThan(0.3);
      if (i > 0) expect(Math.sign(totals[i])).toBe(-Math.sign(totals[i - 1]));
    }
  });

  it("skips beats closer than KICK_GAP, stays still at Reactivity 0, and delivers the same impulse at any step rate", () => {
    /** @param {number} hz @param {number} every beat every N frames @param {number} r */
    const total = (hz, every, r) => {
      const k = createKicks();
      let sum = 0;
      for (let f = 0; f < hz; f++) {
        k.trigger(f % every === 0, 1, r);
        const a = k.step(1 / hz);
        sum += Math.abs(a);
      }
      return sum;
    };
    // 20 beats/s asked, at most 1 / KICK_GAP kicks happen.
    expect(total(60, 3, 1)).toBeLessThanOrEqual(Math.ceil(1 / KICK_GAP) + 1e-9);
    expect(total(60, 3, 0)).toBe(0);
    expect(total(120, 60, 1)).toBeCloseTo(total(60, 30, 1), 9);
  });
});

describe("palettes and the trail ramp", () => {
  it("offers currents (default), sea glass, sunset and mono; anything else is currents", () => {
    expect(PALETTES).toEqual(["currents", "sea glass", "sunset", "mono"]);
    expect(palette("nope")).toBe(palette("currents"));
    for (const name of PALETTES) {
      const p = palette(name);
      for (const key of ["line", "hi", "shadow", "gap", "hot", "warm", "old"]) {
        const c = /** @type {Float32Array} */ (/** @type {any} */ (p)[key]);
        expect(c.length, `${name}.${key}`).toBe(3);
        for (const v of c) expect(v >= 0 && v <= 1, `${name}.${key}`).toBe(true);
      }
    }
    const c = palette("currents");
    expect(c.line[2]).toBeGreaterThan(c.line[1]); // lilac: blue and red over green
    expect(c.line[0]).toBeGreaterThan(c.line[1]);
    expect(Math.max(...c.gap)).toBeLessThan(0.05); // on black
  });

  it("colours the trail by age since it passed the sphere: red when fresh, through orange, clamped when old", () => {
    const p = palette("currents");
    const out = new Float32Array(3);
    trailColor(p, 0, out);
    expect(out[0]).toBeGreaterThan(0.8);
    expect(out[1]).toBeLessThan(0.3);
    let prevG = -1;
    for (let i = 0; i <= 20; i++) {
      trailColor(p, (i / 20) * TRAIL_OLD, out);
      expect(out[1]).toBeGreaterThanOrEqual(prevG); // red → orange: green rises
      prevG = out[1];
    }
    expect(out[1]).toBeGreaterThan(0.4);
    const old = Array.from(out);
    trailColor(p, TRAIL_OLD * 5, out);
    expect(Array.from(out)).toEqual(old);
  });
});

describe("gapOpacity", () => {
  it("paints the gaps opaque on the black backdrop and leaves them transparent with none (unknown → black)", () => {
    expect(BACKDROPS).toEqual(["black", "none"]);
    expect(gapOpacity("black")).toBe(1);
    expect(gapOpacity("none")).toBe(0);
    expect(gapOpacity("??")).toBe(1);
  });
});

describe("createGlow", () => {
  /** Rises (a new increase after a fall) per second under a 10 Hz strobe. @param {boolean} reduce */
  const rises = (reduce) => {
    const g = createGlow();
    let prev = 1;
    let falling = true;
    let n = 0;
    for (let f = 0; f < 60 * 4; f++) {
      g.step(f % 6 === 0, 1, 1 / 60, reduce, 1);
      expect(g.value).toBeGreaterThanOrEqual(1);
      expect(g.value).toBeLessThanOrEqual(1 + GLOW_MAX);
      if (g.value > prev + 1e-6 && falling) {
        n++;
        falling = false;
      } else if (g.value < prev - 1e-6) falling = true;
      prev = g.value;
    }
    return n / 4;
  };

  it("brightens the whole frame a little on beats, at most 3 times a second with reduceFlashing", () => {
    expect(rises(false)).toBeGreaterThan(8);
    expect(rises(true)).toBeLessThanOrEqual(3);
    expect(rises(true)).toBeGreaterThan(1);
  });
});

describe("motion", () => {
  const out = { speed: 0, turbulence: 0, reactivity: 0 };
  it("with Reduce motion, swaps params still at their defaults for calmer ones and respects the user's own values", () => {
    motion({ ...MOTION_DEFAULTS }, false, out);
    expect(out).toEqual(MOTION_DEFAULTS);
    motion({ ...MOTION_DEFAULTS }, true, out);
    expect(out).toEqual(REDUCED_MOTION);
    for (const k of /** @type {const} */ (["speed", "turbulence", "reactivity"])) {
      expect(REDUCED_MOTION[k]).toBeLessThan(MOTION_DEFAULTS[k]);
    }
    motion({ speed: 1.7, turbulence: 2, reactivity: 1 }, true, out);
    expect(out).toEqual({ speed: 1.7, turbulence: 2, reactivity: REDUCED_MOTION.reactivity });
  });
});
