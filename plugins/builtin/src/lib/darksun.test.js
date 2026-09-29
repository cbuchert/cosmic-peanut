// @ts-check
import { describe, expect, it } from "vitest";
import { createGlow, GLOW_RANGE, DEFAULTS, isPainted, layout, PALETTES, palette, resolveParams, BEAM_BRIGHT, BEAM_WIDTH, createBeam, createDiamond, createSun, createSurge, DIAMOND_RATE, REACH_MAX, REACH_MIN, RIM_MAX, RIM_MIN } from "./darksun.js";

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

describe("layout", () => {
  const sizes = [
    [2560, 1440],
    [1440, 2560],
    [3440, 1440],
    [400, 300],
    [300, 900],
    [1000, 1000],
  ];
  const opts = { sunSize: 1, rangeWidth: 0.5, rangeDepth: 1 };

  it("puts the horizon at half height and the sun top-middle, clear of the edge and the horizon", () => {
    for (const [w, h] of sizes) {
      for (const sunSize of [0.5, 1, 1.6]) {
        const L = layout(w, h, { ...opts, sunSize }, /** @type {any} */ ({}));
        const tag = `${w}x${h} sun ${sunSize}`;
        expect(L.horizon, tag).toBeCloseTo(h / 2, 6);
        expect(L.sunX, tag).toBeCloseTo(w / 2, 6);
        expect(L.sunY, tag).toBeGreaterThanOrEqual(0.18 * h);
        expect(L.sunY - 1.2 * L.sunR, tag).toBeGreaterThanOrEqual(0); // rim clear of the top
        expect(L.sunY + 1.3 * L.sunR, tag).toBeLessThanOrEqual(L.horizon); // well above the horizon
        expect(L.sunR, tag).toBeGreaterThan(0.02 * Math.min(w, h));
      }
    }
  });

  it("centres the range on the requested width; its depth and the beam scale with min(w, h)", () => {
    for (const [w, h] of sizes) {
      const L = layout(w, h, opts, /** @type {any} */ ({}));
      const tag = `${w}x${h}`;
      expect(L.rangeHalf, tag).toBeCloseTo(0.25 * w, 6);
      expect(L.rangeDepth, tag).toBeGreaterThan(0.1 * Math.min(w, h));
      expect(L.rangeDepth, tag).toBeLessThanOrEqual(0.8 * (h - L.horizon)); // never reaches the bottom
      expect(L.beamWidth, tag).toBeGreaterThan(0);
      expect(L.beamWidth, tag).toBeLessThan(0.03 * Math.min(w, h));
      const big = layout(2 * w, 2 * h, opts, /** @type {any} */ ({}));
      for (const k of /** @type {const} */ (["horizon", "sunX", "sunY", "sunR", "rangeHalf", "rangeDepth", "beamWidth"]))
        expect(big[k], `${tag} ${k}`).toBeCloseTo(2 * L[k], 4);
      const deep = layout(w, h, { ...opts, rangeDepth: 2 }, /** @type {any} */ ({}));
      expect(deep.rangeDepth, tag).toBeGreaterThan(L.rangeDepth);
      expect(deep.rangeDepth, tag).toBeLessThanOrEqual(0.8 * (h - L.horizon));
    }
  });
});

describe("palette and backdrop", () => {
  const colors = (/** @type {unknown} */ name) => palette(name, new Float32Array(PALETTES.SIZE));
  const sat = (/** @type {Float32Array} */ c, /** @type {number} */ i) =>
    Math.max(c[i], c[i + 1], c[i + 2]) - Math.min(c[i], c[i + 1], c[i + 2]);

  it("offers dusk (default), ash, teal and gold; anything else is dusk", () => {
    expect(PALETTES.names).toEqual(["dusk", "ash", "teal", "gold"]);
    const all = PALETTES.names.map(colors);
    for (const c of all) for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
    for (let a = 0; a < all.length; a++)
      for (let b = a + 1; b < all.length; b++) expect(Array.from(all[a])).not.toEqual(Array.from(all[b]));
    expect(Array.from(colors("nope"))).toEqual(Array.from(all[0]));
    expect(Array.from(colors(undefined))).toEqual(Array.from(all[0]));
    expect(Array.from(colors("constructor"))).toEqual(Array.from(all[0]));
  });

  it("dusk is the cover's ash-grey sky over a salmon-pink horizon; ash is monochrome", () => {
    const d = colors("dusk");
    const top = PALETTES.SKY_TOP * 3;
    const low = PALETTES.SKY_LOW * 3;
    expect(sat(d, top)).toBeLessThan(0.12); // ash grey
    expect(d[low]).toBeGreaterThan(d[low + 1] + 0.2); // salmon: red well over green ...
    expect(d[low + 2]).toBeGreaterThan(d[low + 1] - 0.05); // ... with a touch of blue, not orange
    const ash = colors("ash");
    for (let i = 0; i < PALETTES.SIZE; i += 3) expect(sat(ash, i), `colour ${i / 3}`).toBeLessThan(1e-6);
  });

  it("paints the sky and ground unless the backdrop is none", () => {
    expect(isPainted("painted")).toBe(true);
    expect(isPainted("none")).toBe(false);
    expect(isPainted(undefined)).toBe(true);
  });
});

describe("resolveParams", () => {
  const base = { reactivity: 1, rangeWidth: 0.5, rangeDepth: 1, beam: 1, sunSize: 1, palette: "dusk", backdrop: "painted" };

  it("passes the params through, clamped, with full motion", () => {
    const r = resolveParams({ ...base, reactivity: 1.4, rangeWidth: 9, sunSize: NaN }, false, /** @type {any} */ ({}));
    expect(r.reactivity).toBe(1.4);
    expect(r.rangeWidth).toBe(0.7);
    expect(r.sunSize).toBe(DEFAULTS.sunSize);
    expect(r.motion).toBe(1);
  });

  it("Reduce motion calms the defaults (slower drift, softer reactivity) but keeps what the user chose", () => {
    const calm = resolveParams(base, true, /** @type {any} */ ({}));
    expect(calm.motion).toBeLessThan(0.6);
    expect(calm.reactivity).toBeLessThan(DEFAULTS.reactivity);
    const chosen = resolveParams({ ...base, reactivity: 1.5 }, true, /** @type {any} */ ({}));
    expect(chosen.reactivity).toBe(1.5);
  });
});

describe("createGlow: the horizon breathes with the mids", () => {
  it("rises with midAtt, smoothly, bounded, and adds the (already limited) surge", () => {
    const glow = createGlow();
    const dt = 1 / 60;
    for (let f = 0; f < 120; f++) glow.step(0, 0, dt, 1);
    const rest = glow.value;
    expect(rest).toBeCloseTo(GLOW_RANGE[0], 3);
    let prev = rest;
    for (let f = 0; f < 120; f++) {
      glow.step(f % 20 < 2 ? 50 : 1.6, 0, dt, 2);
      expect(Math.abs(glow.value - prev)).toBeLessThan(0.05);
      expect(glow.value).toBeLessThanOrEqual(GLOW_RANGE[1] + 1e-9);
      prev = glow.value;
    }
    expect(glow.value).toBeGreaterThan(rest + 0.2);
    const flared = glow.step(1.6, 1, dt, 2);
    expect(flared).toBeGreaterThan(prev);
    expect(flared).toBeLessThanOrEqual(GLOW_RANGE[1] + 0.5 + 1e-9);
    const still = createGlow();
    for (let f = 0; f < 120; f++) still.step(2, 0, dt, 0);
    expect(still.value).toBeCloseTo(GLOW_RANGE[0], 6);
  });
});
