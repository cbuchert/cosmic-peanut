// @ts-check
import { describe, expect, it } from "vitest";
import { createGlow, GLOW_RANGE, DEFAULTS, isPainted, layout, PALETTES, palette, resolveParams, BEAM_BRIGHT, BEAM_WIDTH, createBeam, createDiamond, createSun, createSurge, DIAMOND_RATE, REACH_MAX, REACH_MIN, RIM_MAX, RIM_MIN } from "./darksun.js";
import { beatHit, createBreath, createEnergy, createFlow, createSkyTone, FLOW, loudness, SKY_BRIGHT } from "./darksun.js";

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

describe("loudness and createEnergy: how loud the music is, absolutely (quiet passages stay calm)", () => {
  it("maps rms in dB to 0–1, monotonic and bounded; NaN is silence", () => {
    expect(loudness(0)).toBe(0);
    expect(loudness(NaN)).toBe(0);
    expect(loudness(0.01)).toBeLessThan(0.1); // −40 dBFS: a quiet passage
    expect(loudness(0.25)).toBeGreaterThan(0.9); // mastered, loud
    expect(loudness(5)).toBe(1);
    let prev = 0;
    for (let r = 0.001; r < 1; r *= 1.2) {
      const l = loudness(r);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });

  it("smooths it (a quick rise, a slower fall) the same at 60 and 120 Hz", () => {
    /** @param {number} hz @param {number} secs @param {number} rms */
    const run = (hz, secs, rms, e = createEnergy()) => {
      for (let f = 0; f < hz * secs; f++) e.step(rms, 1 / hz);
      return e;
    };
    expect(Math.abs(run(60, 0.3, 0.3).value - run(120, 0.3, 0.3).value)).toBeLessThan(0.01);
    expect(run(60, 0.5, 0.3).value).toBeGreaterThan(0.7); // rises within half a second
    const up = run(60, 3, 0.3);
    run(60, 0.5, 0, up);
    expect(up.value).toBeGreaterThan(0.4); // falls more slowly
    run(60, 6, 0, up);
    expect(up.value).toBeLessThan(0.02);
    // A single loud sample barely moves it: no jitter.
    const e = run(60, 1, 0.01);
    const before = e.value;
    e.step(1, 1 / 60);
    expect(e.value - before).toBeLessThan(0.1);
  });
});

describe("beatHit: a beat's kick to the landscape, scaled by the music's energy", () => {
  it("is 0 without an onset, grows with strength, energy and reactivity, and stays 0–1", () => {
    expect(beatHit(false, 1, 1, 1)).toBe(0);
    expect(beatHit(true, 1, 1, 1)).toBeGreaterThan(0.8);
    expect(beatHit(true, 1, 0.1, 1)).toBeLessThan(0.25 * beatHit(true, 1, 1, 1)); // quiet: a nudge
    expect(beatHit(true, 0.3, 1, 1)).toBeLessThan(beatHit(true, 1, 1, 1));
    expect(beatHit(true, 1, 1, 0)).toBe(0);
    expect(beatHit(true, 1, 0.5, 2)).toBeGreaterThan(beatHit(true, 1, 0.5, 1));
    expect(beatHit(true, 99, 99, 99)).toBeLessThanOrEqual(1);
    expect(beatHit(true, NaN, NaN, NaN)).toBe(0);
  });
});

describe("createFlow: the washes' drift clock and turbulence follow the energy and surge on beats", () => {
  const dt = 1 / 60;
  it("drifts slowly at rest and several times faster when loud, smoothly, the same at 60 and 120 Hz", () => {
    /** @param {number} hz @param {number} energy @param {number} r @param {number} motion */
    const run = (hz, energy, r = 1, motion = 1) => {
      const f = createFlow();
      for (let i = 0; i < hz * 4; i++) f.step(energy, 0, 1 / hz, r, motion);
      return f;
    };
    const calm = run(60, 0);
    const loud = run(60, 1);
    expect(calm.clock).toBeCloseTo(4 * FLOW.REST, 2);
    expect(loud.clock).toBeGreaterThan(3 * calm.clock);
    expect(Math.abs(run(120, 0.7).clock - run(60, 0.7).clock)).toBeLessThan(0.01 * run(60, 0.7).clock);
    expect(loud.turb).toBeGreaterThan(calm.turb + 0.3);
    expect(run(60, 1, 0).clock).toBeCloseTo(calm.clock, 6); // reactivity 0: the resting drift
    expect(run(60, 1, 1, 0.4).clock).toBeCloseTo(0.4 * loud.clock, 6); // Reduce motion
  });

  it("surges on a beat: faster for a moment, then back, bounded and never stepping", () => {
    const f = createFlow();
    for (let i = 0; i < 120; i++) f.step(0.8, 0, dt, 1, 1);
    const cruise = f.speed;
    let prev = f.speed;
    let top = 0;
    for (let i = 0; i < 120; i++) {
      f.step(0.8, i % 30 === 0 ? 1 : 0, dt, 2, 1);
      expect(f.speed).toBeLessThanOrEqual(FLOW.MAX);
      expect(f.turb).toBeLessThanOrEqual(1);
      expect(Math.abs(f.speed - prev)).toBeLessThan(0.25 * FLOW.MAX); // eased, not a jump
      top = Math.max(top, f.speed);
      prev = f.speed;
    }
    expect(top).toBeGreaterThan(1.5 * cruise);
    for (let i = 0; i < 120; i++) f.step(0.8, 0, dt, 1, 1);
    expect(f.speed).toBeCloseTo(cruise, 2);
  });
});

describe("createSkyTone: the sky warms and brightens as the music opens up, cools to ash when sparse", () => {
  const dt = 1 / 60;
  /** @param {number} centroid @param {number} energy @param {number} r */
  const settle = (centroid, energy, r = 1, t = createSkyTone()) => {
    for (let i = 0; i < 600; i++) t.step(centroid, energy, dt, r, true);
    return t;
  };
  it("is monotonic in brightness and energy, bounded, and the cover's tone at reactivity 0", () => {
    const sparse = settle(0.03, 0.05);
    const open = settle(0.2, 1);
    expect(open.warm).toBeGreaterThan(sparse.warm + 0.4);
    expect(open.bright).toBeGreaterThan(sparse.bright + 0.1);
    expect(settle(0.15, 0.5).warm).toBeGreaterThan(settle(0.05, 0.5).warm);
    expect(settle(0.1, 0.8).bright).toBeGreaterThan(settle(0.1, 0.3).bright);
    for (const t of [sparse, open, settle(9, 9, 2), settle(NaN, NaN)]) {
      expect(t.warm).toBeGreaterThanOrEqual(0);
      expect(t.warm).toBeLessThanOrEqual(1);
      expect(t.bright).toBeGreaterThanOrEqual(SKY_BRIGHT[0]);
      expect(t.bright).toBeLessThanOrEqual(SKY_BRIGHT[1]);
    }
    const still = settle(0.2, 1, 0);
    expect(still.warm).toBeCloseTo(0.5, 6);
    expect(still.bright).toBeCloseTo(1, 6);
  });

  it("changes smoothly, and under reduceFlashing starts at most 3 brightenings a second", () => {
    const t = settle(0.05, 0.1);
    let prevW = t.warm;
    let prevB = t.bright;
    let rises = 0;
    let falling = true;
    for (let i = 0; i < 600; i++) {
      const on = Math.floor(i / 3) % 2 === 0; // a 10 Hz strobe of energy and brightness
      t.step(on ? 0.25 : 0.02, on ? 1 : 0, dt, 2, true);
      expect(Math.abs(t.warm - prevW)).toBeLessThan(0.02);
      expect(Math.abs(t.bright - prevB)).toBeLessThan(0.01);
      if (t.bright > prevB && falling) rises++;
      if (t.bright !== prevB) falling = t.bright < prevB;
      prevW = t.warm;
      prevB = t.bright;
    }
    expect(rises / 10).toBeLessThanOrEqual(3);
  });
});

describe("createBreath: between beats the landscape breathes in time (when the tempo is known)", () => {
  const dt = 1 / 60;
  it("peaks on the beat and dips between, scaled by energy and reactivity, 0 without a tempo", () => {
    const b = createBreath();
    for (let i = 0; i < 240; i++) b.step(120, (i / 30) % 1, 1, dt, 1);
    const onBeat = b.step(120, 0, 1, dt, 1);
    const offBeat = b.step(120, 0.5, 1, dt, 1);
    expect(onBeat).toBeGreaterThan(0.8);
    expect(offBeat).toBeLessThan(0.1);
    const quiet = createBreath();
    for (let i = 0; i < 240; i++) quiet.step(120, (i / 30) % 1, 0.1, dt, 1);
    expect(quiet.step(120, 0, 0.1, dt, 1)).toBeLessThan(0.25 * onBeat);
    const none = createBreath();
    for (let i = 0; i < 240; i++) none.step(0, 0, 1, dt, 1);
    expect(none.value).toBeLessThan(0.01);
    const still = createBreath();
    for (let i = 0; i < 240; i++) still.step(120, (i / 30) % 1, 1, dt, 0);
    expect(still.value).toBe(0);
  });

  it("fades in and out as the tempo is found and lost, never jumping", () => {
    const b = createBreath();
    let prev = 0;
    for (let i = 0; i < 600; i++) {
      const bpm = i > 120 && i < 400 ? 120 : 0;
      const v = b.step(bpm, bpm ? (i / 30) % 1 : 0, 1, dt, 2);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.12); // a 2 Hz breath moves ≈ 0.1 a frame at most
      prev = v;
    }
  });
});
