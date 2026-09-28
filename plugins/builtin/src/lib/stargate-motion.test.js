// @ts-check
import { describe, expect, it } from "vitest";
import {
  BREATH,
  createIntensity,
  createRoll,
  createSolar,
  createSurge,
  DEFAULT_ROLL,
  DEFAULT_SPEED,
  effectiveMotion,
  REDUCED_ROLL,
  REDUCED_SPEED,
  SOLAR_COOLDOWN,
  SURGE_MAX,
} from "./stargate-motion.js";

describe("createRoll", () => {
  it("integrates the roll rate (rad/s) at any frame rate; negative rolls the other way", () => {
    for (const hz of [60, 120]) {
      for (const rate of [0.25, -0.4]) {
        const r = createRoll();
        let a = 0;
        for (let f = 0; f < hz * 4; f++) a = r.step(1 / hz, rate, 1);
        expect(a, `${hz} Hz ${rate}`).toBeCloseTo(rate * 4, 6);
      }
    }
  });

  it("breathes with the bass: faster on heavy bass, slower when it drops, bounded and without jerks", () => {
    const r = createRoll();
    const dt = 1 / 60;
    let prevRate = 0.25;
    let max = 0;
    let min = Infinity;
    for (let f = 0; f < 600; f++) {
      const bass = f % 60 < 5 ? 10 : 0; // violent kicks, silence between
      const before = r.angle;
      r.step(dt, 0.25, bass);
      const rate = (r.angle - before) / dt;
      expect(Math.abs(rate - prevRate)).toBeLessThan(0.25 * BREATH * 0.1); // < 10% of the swing per frame
      max = Math.max(max, rate);
      min = Math.min(min, rate);
      prevRate = rate;
    }
    expect(max).toBeLessThanOrEqual(0.25 * (1 + BREATH) + 1e-9);
    expect(min).toBeGreaterThanOrEqual(0.25 * (1 - BREATH) - 1e-9);
    expect(max - min).toBeGreaterThan(0.25 * BREATH * 0.3); // it does breathe

    const heavy = createRoll();
    const light = createRoll();
    for (let f = 0; f < 300; f++) {
      heavy.step(dt, 0.25, 1.8);
      light.step(dt, 0.25, 0.3);
    }
    expect(heavy.angle).toBeGreaterThan(light.angle);
  });
});

describe("effectiveMotion", () => {
  const m = { roll: 0, speed: 0 };

  it("passes the user's roll and speed through", () => {
    effectiveMotion(-0.6, 1.7, false, m);
    expect(m).toEqual({ roll: -0.6, speed: 1.7 });
    effectiveMotion(DEFAULT_ROLL, DEFAULT_SPEED, false, m);
    expect(m).toEqual({ roll: DEFAULT_ROLL, speed: DEFAULT_SPEED });
  });

  it("with Reduce motion, swaps untouched defaults for gentler ones but respects chosen values", () => {
    effectiveMotion(DEFAULT_ROLL, DEFAULT_SPEED, true, m);
    expect(m).toEqual({ roll: REDUCED_ROLL, speed: REDUCED_SPEED });
    expect(Math.abs(REDUCED_ROLL)).toBeLessThan(Math.abs(DEFAULT_ROLL));
    expect(REDUCED_SPEED).toBeLessThan(DEFAULT_SPEED);
    effectiveMotion(0.5, 2, true, m);
    expect(m).toEqual({ roll: 0.5, speed: 2 });
  });
});

describe("createSurge", () => {
  const dt = 1 / 60;
  /** Seconds until `pred(value)` holds, feeding a constant bassAtt. @param {ReturnType<typeof createSurge>} s */
  const until = (s, /** @type {number} */ bass, /** @type {(v: number) => boolean} */ pred) => {
    for (let f = 1; f < 600; f++) if (pred(s.step(bass, dt))) return f * dt;
    return Infinity;
  };

  it("is exactly 1 (no surge) for average or quiet bass", () => {
    const s = createSurge();
    for (const b of [1, 0.4, 0]) for (let f = 0; f < 60; f++) expect(s.step(b, dt)).toBe(1);
  });

  it("surges quickly on heavy bass, bounded, and settles back slowly and smoothly", () => {
    const s = createSurge();
    const tUp = until(s, 100, (v) => v >= 1 + 0.9 * SURGE_MAX);
    expect(tUp).toBeLessThan(0.4);
    for (let f = 0; f < 120; f++) expect(s.step(100, dt)).toBeLessThanOrEqual(1 + SURGE_MAX);
    let prev = s.step(0, dt);
    const tDown = until(s, 0, (v) => {
      expect(Math.abs(v - prev)).toBeLessThan(0.1 * SURGE_MAX); // no jerks
      prev = v;
      return v <= 1 + 0.1 * SURGE_MAX;
    });
    expect(tDown).toBeGreaterThan(2 * tUp);
    expect(tDown).toBeLessThan(3);
  });
});

/** Most rise starts in any 1 s window of a per-frame series. @param {number[]} v @param {number} hz */
function maxRisesPerSecond(v, hz) {
  /** @type {number[]} */
  const starts = [];
  let rising = false;
  for (let i = 1; i < v.length; i++) {
    if (v[i] > v[i - 1] + 1e-6) {
      if (!rising) starts.push(i / hz);
      rising = true;
    } else if (v[i] < v[i - 1] - 1e-6) rising = false;
  }
  // Half-open 1 s windows; the limiter spaces rises exactly 1/3 s apart, so allow for rounding.
  let best = 0;
  for (let i = 0; i < starts.length; i++) {
    best = Math.max(best, starts.filter((t) => t >= starts[i] && t - starts[i] < 1 - 1e-9).length);
  }
  return best;
}

describe("createIntensity", () => {
  it("brightens on onsets but, with reduceFlashing, swings at most 3 times a second under a 10 Hz strobe", () => {
    for (const hz of [60, 120]) {
      for (const reduce of [true, false]) {
        const it = createIntensity();
        /** @type {number[]} */
        const out = [];
        for (let f = 0; f < hz * 4; f++) {
          const onset = f % (hz / 10) === 0;
          out.push(it.step(onset, onset ? 1 : 0, 1.8, 1 / hz, reduce));
        }
        expect(Math.max(...out)).toBeGreaterThan(1.1);
        expect(Math.min(...out)).toBeGreaterThanOrEqual(1);
        const rises = maxRisesPerSecond(out, hz);
        if (reduce) expect(rises, `${hz} Hz`).toBeLessThanOrEqual(3);
        else expect(rises, `${hz} Hz`).toBeGreaterThan(3);
      }
    }
  });
});

describe("createSolar", () => {
  const dt = 1 / 60;

  it("a big hit starts a smooth solarized moment that rises, holds and fades within ~2 s", () => {
    const s = createSolar();
    let prev = 0;
    let peak = 0;
    let end = -1;
    for (let f = 0; f < 240; f++) {
      const onset = f === 1;
      const v = s.step(onset, onset ? 0.9 : 0, 1.8, dt, true);
      expect(Math.abs(v - prev)).toBeLessThanOrEqual(dt / 0.3 + 1e-9); // eased, never a cut
      peak = Math.max(peak, v);
      if (peak === 1 && v === 0 && end < 0) end = f * dt;
      prev = v;
    }
    expect(peak).toBe(1);
    expect(end).toBeGreaterThan(1);
    expect(end).toBeLessThan(2.5);
  });

  it("stays rare: no more than one moment per cooldown, and ordinary beats never trigger one", () => {
    const s = createSolar();
    let starts = 0;
    let prev = 0;
    for (let f = 0; f < 60 * 30; f++) {
      const onset = f % 6 === 0;
      const v = s.step(onset, 1, 2, dt, true);
      if (v > 0 && prev === 0) starts++;
      prev = v;
    }
    expect(starts).toBeLessThanOrEqual(Math.ceil(30 / SOLAR_COOLDOWN));
    expect(starts).toBeGreaterThan(0);
    const calm = createSolar();
    for (let f = 0; f < 60 * 30; f++) expect(calm.step(f % 30 === 0, 0.3, 1.1, dt, true)).toBe(0);
  });
});
