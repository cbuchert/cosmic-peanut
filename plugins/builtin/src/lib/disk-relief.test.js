// @ts-check
import { describe, expect, it } from "vitest";
import { rippleLift } from "./disk3d.js";
import {
  createKitePops,
  KITE_BEAT,
  KITE_HEAVE,
  KITE_REACH,
  kiteBound,
  kiteFade,
  kiteHeight,
  kiteLift,
  kiteScale,
  keyLight,
  POP_RING_BAND,
  RELIEF_MIX,
  reliefMix,
  rippleMax,
  sphereLiftMax,
} from "./disk-relief.js";
import { LIFT_VARY } from "./tess-music.js";
import { CARD_HALF, RELIEF_BLOCK, reliefProfile } from "./tess.js";

/** Small seeded PRNG for repeatable random cases. @param {number} seed */
function rng(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the carved kites' scale", () => {
  it("is the kite's size at that point of the disk: √A (1 − |w|²), so the rim's kites carve to nothing", () => {
    expect(kiteScale(0.4, 0)).toBeCloseTo(0.4, 12);
    expect(kiteScale(0.4, 0.5)).toBeCloseTo(0.3, 12);
    expect(kiteScale(0.4, 1)).toBe(0);
    expect(kiteScale(0.4, 1.2)).toBe(0);
  });
  it("fades the carving out where a kite spans too few height texels to be carved cleanly", () => {
    const texel = 0.004;
    expect(kiteFade(0.4, texel)).toBe(1);
    expect(kiteFade(0.001, texel)).toBe(0);
    let last = -1;
    for (let s = 0; s < 0.2; s += 0.001) {
      const k = kiteFade(s, texel);
      expect(k).toBeGreaterThanOrEqual(last);
      last = k;
    }
  });
});

describe("Relief → how far the music's lift is carried by whole kites", () => {
  it("is 0 at Relief 0 (the smooth ripple and heave of the print before relief) and 1 from RELIEF_MIX", () => {
    expect(reliefMix(0)).toBe(0);
    expect(reliefMix(RELIEF_MIX)).toBe(1);
    expect(reliefMix(0.6)).toBe(1);
    expect(reliefMix(RELIEF_MIX / 2)).toBeCloseTo(0.5, 9);
    expect(RELIEF_MIX).toBeLessThan(0.6); // the default is all kites
  });
});

describe("a kite's height (disk.glsl diskRelief)", () => {
  const base = { relief: 0.6, prof: 1, theta: 0, x: 0, hop: 0.08, lift: 0, sPx: 0.38, kPx: 1, sTile: 0.38, kTile: 1 };
  it("puts a resting top on the face plane and cuts the outline's groove below it", () => {
    expect(kiteHeight({ ...base, prof: 1 })).toBeCloseTo(0, 12);
    expect(kiteHeight({ ...base, prof: 0 })).toBeCloseTo(-0.6 * RELIEF_BLOCK * 0.38, 12);
  });
  it("is flat at Relief 0 with nothing lifting", () => {
    for (const prof of [0, 0.3, 1]) expect(kiteHeight({ ...base, relief: 0, prof })).toBe(0);
  });
  it("lifts the whole kite, in units of its own size", () => {
    const h = kiteHeight({ ...base, lift: 0.1 }) - kiteHeight(base);
    expect(h).toBeCloseTo(0.1 * 0.38, 12);
  });
  it("stays within kiteBound for any profile, lift, card turn and place on the face", () => {
    const rnd = rng(3);
    const kiteA = 0.39;
    for (let i = 0; i < 3000; i++) {
      const relief = rnd();
      const lift = 0.3 * rnd();
      const flipping = rnd() < 0.5;
      const theta = flipping ? Math.PI * rnd() : 0;
      const r = 0.99 * rnd();
      const rc = Math.min(0.99, Math.max(0, r + 0.1 * (rnd() - 0.5)));
      const k = {
        relief,
        prof: reliefProfile(0.3 * rnd(), rnd()),
        theta,
        x: 3 * CARD_HALF * (rnd() - 0.5),
        hop: 0.08,
        lift: lift * (1 - LIFT_VARY + 2 * LIFT_VARY * rnd()) - 0.02 * rnd(), // a spring may dip
        sPx: kiteScale(kiteA, r),
        kPx: rnd(),
        sTile: kiteScale(kiteA, rc),
        kTile: rnd(),
      };
      const b = kiteBound({ relief, kiteA, lift: lift * (1 + LIFT_VARY), flipping, hop: 0.08, smooth: 0 });
      const h = kiteHeight(k);
      expect(h).toBeGreaterThanOrEqual(b.lo - 1e-12);
      expect(h).toBeLessThanOrEqual(b.hi + 1e-12);
    }
  });
  it("bounds tightly: a groove at the centre reaches lo, a fully lifted top hi", () => {
    const kiteA = 0.39;
    const b = kiteBound({ relief: 0.6, kiteA, lift: 0.2, flipping: false, hop: 0.08, smooth: 0.05 });
    expect(kiteHeight({ ...base, prof: 0, sPx: kiteA })).toBeCloseTo(b.lo, 12);
    expect(kiteHeight({ ...base, lift: 0.2, sTile: kiteA, sPx: kiteA }) + 0.05).toBeCloseTo(b.hi, 12);
  });
});

describe("the sphere scene's kite lift: the beat's ripple, the spectrum's heave, onset pops", () => {
  const bands = Float32Array.from({ length: 16 }, (_, i) => 0.2 + 0.05 * i);
  const pops = new Float32Array([0.05, 1.2, 33, 0, 0, 0, 0, 0, 0.02, 0.4, 7, 0]);
  it("lifts kites by their hyperbolic distance from the impact as the ripple passes", () => {
    const o = { age: 0.1, agePrev: 99, dPrev: 0, period: 0.5, dImpact: 0, dCentre: 0.5, vary: 1, beat: KITE_BEAT, heave: 0, ringR: 4.6, bands, pops, hit: 0 };
    expect(kiteLift(o)).toBeCloseTo(KITE_BEAT * rippleLift(0.1, 0, 0.5, KITE_REACH), 12);
    // Its own reach, wider than the smooth swell's: the wave of kites crosses much of the face.
    expect(kiteLift({ ...o, age: 0.5, dImpact: 1.2 })).toBeCloseTo(KITE_BEAT * rippleLift(0.5, 1.2, 0.5, KITE_REACH), 12);
    expect(KITE_REACH).toBeGreaterThan(1.5);
    // The front reaches a kite 0.6 out 0.2 s after the beat (RIPPLE_SPEED 3): not yet at 0.15 s.
    expect(kiteLift({ ...o, age: 0.15, dImpact: 0.6 })).toBe(0);
    expect(kiteLift({ ...o, age: 0.28, dImpact: 0.6 })).toBeGreaterThan(0);
  });
  it("lets the previous beat's ripple run out after the next beat lands (never cut short)", () => {
    const o = { age: 0.01, agePrev: 0.51, dPrev: 1.2, period: 0.5, dImpact: 3, dCentre: 0.5, vary: 1, beat: KITE_BEAT, heave: 0, ringR: 4.6, bands, pops, hit: 0 };
    expect(kiteLift(o)).toBeCloseTo(KITE_BEAT * rippleLift(0.51, 1.2, 0.5, KITE_REACH), 12);
    expect(kiteLift(o)).toBeGreaterThan(0);
  });
  it("heaves kites ring by ring from the face's centre with the spectrum", () => {
    const o = { age: 99, agePrev: 99, dPrev: 0, period: 0.5, dImpact: 1, dCentre: 0, vary: 1, beat: 0, heave: KITE_HEAVE, ringR: 4.6, bands, pops, hit: 0 };
    expect(kiteLift(o)).toBeCloseTo(KITE_HEAVE * bands[0], 6);
    expect(kiteLift({ ...o, dCentre: 4.6 })).toBeCloseTo(KITE_HEAVE * bands[15], 6);
  });
  it("pops the chosen kites (hit) near each pop's ring of distance from the impact", () => {
    const o = { age: 99, agePrev: 99, dPrev: 0, period: 0.5, dImpact: 1.25, dCentre: 0, vary: 1, beat: 0, heave: 0, ringR: 4.6, bands, pops, hit: 1 };
    expect(kiteLift(o)).toBeCloseTo(0.05, 6);
    expect(kiteLift({ ...o, hit: 0 })).toBe(0);
    expect(kiteLift({ ...o, dImpact: 1.2 + POP_RING_BAND + 0.01 })).toBe(0);
  });
  it("never lifts above sphereLiftMax (the march's bound)", () => {
    const rnd = rng(8);
    for (let i = 0; i < 3000; i++) {
      const age = 2 * rnd();
      const period = 0.3 + 0.5 * rnd();
      const beat = KITE_BEAT * 2 * rnd();
      const heave = KITE_HEAVE * 2 * rnd();
      const agePrev = age + period;
      const max = sphereLiftMax(age, agePrev, period, beat, heave, bands, pops);
      const o = { age, agePrev, dPrev: 4 * rnd(), period, dImpact: 4 * rnd(), dCentre: 5 * rnd(), vary: 1 - LIFT_VARY + 2 * LIFT_VARY * rnd(), beat, heave, ringR: 4.6, bands, pops, hit: 1 };
      expect(kiteLift(o)).toBeLessThanOrEqual(max + 1e-9);
    }
  });
  it("bounds the ripple over all distances (and is never loose by much at the start)", () => {
    const rnd = rng(4);
    for (let i = 0; i < 2000; i++) {
      const age = 3 * rnd();
      const period = 0.3 + 0.5 * rnd();
      expect(rippleLift(age, 5 * rnd(), period, KITE_REACH)).toBeLessThanOrEqual(rippleMax(age, period, KITE_REACH) + 1e-12);
      expect(rippleLift(age, 5 * rnd(), period)).toBeLessThanOrEqual(rippleMax(age, period) + 1e-12);
    }
    expect(rippleMax(0.08, 0.5)).toBe(1);
    expect(rippleMax(3, 0.5)).toBeLessThan(1e-3);
  });
});

describe("onset pops on the face: rings of distance from the impact", () => {
  it("takes the ripple's front as a pop's ring when it starts, and keeps it while the pop lasts", () => {
    const p = createKitePops();
    const s = new Float32Array(12);
    s[2] = 41;
    p.step(s, 0.9, 1.5);
    expect(p.pops[0]).toBe(0);
    s[0] = 0.03; // slot 0 starts
    p.step(s, 0.9, 1.5);
    expect(p.pops[0]).toBeCloseTo(0.045, 6);
    expect(p.pops[1]).toBeCloseTo(0.9, 6);
    expect(p.pops[2]).toBe(41);
    s[0] = 0.05;
    p.step(s, 2.1, 1.5);
    expect(p.pops[1]).toBeCloseTo(0.9, 6); // the same pop keeps its ring
    s[0] = 0;
    p.step(s, 2.1, 1.5);
    s[0] = 0.01; // a new pop in the slot, the front now further out
    p.step(s, 2.1, 1.5);
    expect(p.pops[1]).toBeCloseTo(2.1, 6);
  });
  it("scatters a pop with no ripple in flight over the inner rings", () => {
    const p = createKitePops();
    const s = new Float32Array(12);
    s[4] = 0.02;
    s[6] = 12;
    p.step(s, -1, 1);
    expect(p.pops[5]).toBeGreaterThan(0);
    expect(p.pops[5]).toBeLessThan(2);
  });
});

describe("the Light param in the sphere scene", () => {
  const LIGHT = [-0.45, 0.78, 0.43];
  const l = Math.hypot(...LIGHT);
  const base = LIGHT.map((v) => v / l);
  it("is the key light exactly as before at its default (so Relief 0 renders as before, byte for byte)", () => {
    const out = new Float64Array(3);
    keyLight(135, base, out);
    expect(Array.from(out)).toEqual(base);
  });
  it("turns the key light round the scene's up axis, keeping its height", () => {
    const out = new Float64Array(3);
    keyLight(315, base, out);
    expect(out[0]).toBeCloseTo(-base[0], 12);
    expect(out[1]).toBe(base[1]);
    expect(out[2]).toBeCloseTo(-base[2], 12);
    keyLight(225, base, out);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 12);
  });
});
