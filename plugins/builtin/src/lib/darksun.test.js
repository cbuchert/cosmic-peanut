// @ts-check
import { describe, expect, it } from "vitest";
import { BEAM_BRIGHT, BEAM_WIDTH, createBeam, createDiamond, createSun, createSurge, DIAMOND_RATE, REACH_MAX, REACH_MIN, RIM_MAX, RIM_MIN } from "./darksun.js";

describe("createSun: bass swells the rim and the corona's reach", () => {
  it("is bounded and smooth under violent kicks, and grows with the bass", () => {
    const sun = createSun();
    const dt = 1 / 60;
    let prev = sun.step(0, dt, 1);
    let prevRim = sun.rim;
    let prevReach = sun.reach;
    let lo = Infinity;
    let hi = 0;
    for (let f = 0; f < 600; f++) {
      const bass = f % 30 < 3 ? 20 : 0;
      sun.step(bass, dt, 2);
      expect(sun.rim).toBeGreaterThanOrEqual(RIM_MIN);
      expect(sun.rim).toBeLessThanOrEqual(RIM_MAX);
      expect(sun.reach).toBeGreaterThanOrEqual(REACH_MIN);
      expect(sun.reach).toBeLessThanOrEqual(REACH_MAX);
      expect(Math.abs(sun.rim - prevRim)).toBeLessThan(0.1 * (RIM_MAX - RIM_MIN)); // no pops
      expect(Math.abs(sun.reach - prevReach)).toBeLessThan(0.1 * (REACH_MAX - REACH_MIN));
      prevRim = sun.rim;
      prevReach = sun.reach;
      lo = Math.min(lo, sun.rim);
      hi = Math.max(hi, sun.rim);
    }
    expect(hi - lo).toBeGreaterThan(0.1 * (RIM_MAX - RIM_MIN)); // it does swell
    expect(prev).toBeGreaterThanOrEqual(0);

    const heavy = createSun();
    const light = createSun();
    for (let f = 0; f < 120; f++) {
      heavy.step(1.8, dt, 1);
      light.step(0.3, dt, 1);
    }
    expect(heavy.rim).toBeGreaterThan(light.rim);
    expect(heavy.reach).toBeGreaterThan(light.reach);
    const still = createSun();
    for (let f = 0; f < 120; f++) still.step(1.8, dt, 0);
    expect(still.rim).toBeCloseTo(RIM_MIN, 6); // reactivity 0: at rest
  });
});

describe("createDiamond: the rim's brightest point travels slowly, faster with energy", () => {
  it("integrates the same angle at 60 and 120 Hz, and speeds up (boundedly) with energy", () => {
    /** @param {number} hz @param {number} energy @param {number} motion */
    const spin = (hz, energy, motion = 1) => {
      const d = createDiamond();
      const start = d.angle;
      for (let f = 0; f < hz * 10; f++) d.step(energy, 1 / hz, motion);
      return d.angle - start;
    };
    expect(spin(60, 0)).toBeCloseTo(DIAMOND_RATE * 10, 6);
    expect(spin(120, 0)).toBeCloseTo(DIAMOND_RATE * 10, 6);
    expect(Math.abs(spin(60, 1.5) - spin(120, 1.5))).toBeLessThan(0.01);
    expect(spin(60, 1.5)).toBeGreaterThan(spin(60, 0) * 1.2);
    expect(spin(60, 1e9)).toBeLessThan(spin(60, 0) * 3); // slow, whatever the energy
    expect(spin(60, 1.5, 0.5)).toBeCloseTo(spin(60, 1.5) / 2, 6); // motion scale (Reduce motion)
    expect(Math.abs(spin(60, 1.5)) / 10).toBeLessThan(0.3); // radians/s: a slow drift
  });
});

describe("createBeam: the falling light pulses with bass and rms", () => {
  it("rests narrow and dim in silence, widens and brightens on a kick, and stays bounded", () => {
    const beam = createBeam();
    const dt = 1 / 60;
    for (let f = 0; f < 120; f++) beam.step(0, 0, dt, 1);
    expect(beam.width).toBeCloseTo(BEAM_WIDTH[0], 3);
    expect(beam.bright).toBeCloseTo(BEAM_BRIGHT[0], 3);
    for (let f = 0; f < 5; f++) beam.step(2, 0.4, dt, 1); // a kick
    expect(beam.width).toBeGreaterThan(BEAM_WIDTH[0] + 0.4 * (BEAM_WIDTH[1] - BEAM_WIDTH[0]));
    expect(beam.bright).toBeGreaterThan(BEAM_BRIGHT[0] + 0.4 * (BEAM_BRIGHT[1] - BEAM_BRIGHT[0]));
    let prev = beam.width;
    for (let f = 0; f < 60; f++) {
      beam.step(0, 0, dt, 1);
      expect(prev - beam.width).toBeLessThan(0.1 * (BEAM_WIDTH[1] - BEAM_WIDTH[0])); // eases off
      prev = beam.width;
    }
    for (const [bass, rms, r] of [[50, 9, 2], [NaN, NaN, 1], [-4, -1, 2], [1, 0.2, 0]]) {
      for (let f = 0; f < 30; f++) beam.step(bass, rms, dt, r);
      expect(beam.width).toBeGreaterThanOrEqual(BEAM_WIDTH[0]);
      expect(beam.width).toBeLessThanOrEqual(BEAM_WIDTH[1]);
      expect(beam.bright).toBeGreaterThanOrEqual(BEAM_BRIGHT[0]);
      expect(beam.bright).toBeLessThanOrEqual(BEAM_BRIGHT[1]);
    }
  });
});

describe("createSurge: beats flare the beam and the horizon, flash-limited", () => {
  /** Rises (a new climb after a fall) per second under 10 Hz onsets. */
  function risesPerSecond(/** @type {boolean} */ reduce) {
    const surge = createSurge();
    let prev = 0;
    let falling = true;
    let rises = 0;
    for (let f = 0; f < 240; f++) {
      const v = surge.step(f % 6 === 0, 1, 1 / 60, reduce);
      expect(v >= 0 && v <= 1).toBe(true);
      if (v > prev + 1e-6 && falling) rises++;
      falling = v < prev - 1e-6 ? true : v > prev + 1e-6 ? false : falling;
      prev = v;
    }
    return rises / 4;
  }

  it("flares at once on an isolated beat and fades", () => {
    const surge = createSurge();
    for (let f = 0; f < 30; f++) surge.step(false, 0, 1 / 60, true);
    expect(surge.step(true, 0.8, 1 / 60, true)).toBeGreaterThan(0.5);
    let v = 1;
    for (let f = 0; f < 60; f++) v = surge.step(false, 0, 1 / 60, true);
    expect(v).toBeLessThan(0.05);
  });

  it("with reduceFlashing, a 10 Hz strobe of onsets starts at most 3 flares per second", () => {
    expect(risesPerSecond(false)).toBeGreaterThan(8);
    expect(risesPerSecond(true)).toBeLessThanOrEqual(3);
  });
});
