// @ts-check
import { describe, expect, it } from "vitest";
import {
  BLOOM_KNEE,
  BLOOM_THRESHOLD,
  bloomPrefilter,
  circleOfConfusion,
  compositeAlpha,
  createFocus,
  DEFAULT_LOOK,
  LOOKS,
  lookDefines,
  lookOf,
  lookSamples,
  sphereWallAhead,
  SAMPLE_CAPS,
  tubeWallAhead,
  TONE_KNEE,
  tone,
} from "./tess-look.js";
import { paletteOf, PALETTES } from "./tess.js";

const srgbToLinear = (/** @type {number} */ c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe("lookOf / lookDefines", () => {
  it("maps the Look param to classic or cinematic (unknown → the default)", () => {
    expect(LOOKS).toEqual(["classic", "cinematic"]);
    expect(lookOf("classic")).toBe("classic");
    expect(lookOf("cinematic")).toBe("cinematic");
    expect(lookOf("no-such")).toBe(DEFAULT_LOOK);
    expect(lookOf(undefined)).toBe(DEFAULT_LOOK);
    expect(LOOKS).toContain(DEFAULT_LOOK);
  });

  it("adds no define for classic (its programs' text is unchanged) and TESS_CINEMATIC for cinematic", () => {
    expect(lookDefines("classic")).toEqual([]);
    expect(lookDefines("cinematic")).toEqual(["TESS_CINEMATIC"]);
    expect(lookDefines("no-such")).toEqual(lookDefines(DEFAULT_LOOK));
  });
});

describe("tone (the film-like curve: identity to the knee, an exponential shoulder to white)", () => {
  it("maps 0 to 0, rises strictly and never reaches 1", () => {
    expect(tone(0)).toBe(0);
    let prev = 0;
    for (let i = 1; i <= 40000; i++) {
      const x = i / 1000;
      const y = tone(x);
      // strictly while doubles resolve the shoulder (to ~3), never falling after
      if (x < 2) expect(y, `x = ${x}`).toBeGreaterThan(prev);
      else expect(y, `x = ${x}`).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      if (x < 2) expect(y).toBeLessThan(1);
      prev = y;
    }
  });

  it("leaves every palette colour (paper, ink, tiles) as it is: they sit under the knee", () => {
    const pal = new Float32Array(32);
    for (const name of PALETTES) {
      const n = paletteOf(name, pal);
      for (let i = 0; i < (n + 2) * 3; i++) {
        const x = srgbToLinear(pal[i]);
        expect(x, `${name}[${i}]`).toBeLessThanOrEqual(TONE_KNEE);
        expect(tone(x)).toBe(x);
      }
    }
  });

  it("rolls highlights off smoothly: slope 1 either side of the knee, a shoulder above it", () => {
    const h = 1e-6;
    const below = (tone(TONE_KNEE) - tone(TONE_KNEE - h)) / h;
    const above = (tone(TONE_KNEE + h) - tone(TONE_KNEE)) / h;
    expect(below).toBeCloseTo(1, 4);
    expect(above).toBeCloseTo(1, 4);
    expect(tone(1)).toBeLessThan(1);
    expect(tone(1.4)).toBeGreaterThan(0.97);
    // concave above the knee: each step up adds less
    expect(tone(1.2) - tone(1.1)).toBeLessThan(tone(1.0) - tone(0.9));
  });

  it("treats negative light as black", () => {
    expect(tone(-1)).toBe(0);
  });
});

describe("compositeAlpha (the tess families' paper is opaque)", () => {
  it("keeps the canvas opaque: the paper covers every pixel, whatever the colour", () => {
    for (const c of [0, 0.02, 0.5, 1]) expect(compositeAlpha(c, c, c)).toBe(1);
  });
});

describe("bloomPrefilter (only highlights above the paper bloom)", () => {
  it("is 0 up to the threshold's soft knee, so paper and ink never bloom", () => {
    expect(bloomPrefilter(0)).toBe(0);
    expect(bloomPrefilter(BLOOM_THRESHOLD - BLOOM_KNEE)).toBe(0);
    const pal = new Float32Array(32);
    for (const name of PALETTES) {
      const n = paletteOf(name, pal);
      for (let i = 0; i < (n + 2) * 3; i++) expect(bloomPrefilter(srgbToLinear(pal[i])), `${name}[${i}]`).toBe(0);
    }
  });

  it("rises monotonically, continuously, and tends to the excess over the threshold", () => {
    let prev = 0;
    for (let i = 0; i <= 3000; i++) {
      const x = i / 1000;
      const y = bloomPrefilter(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y - prev).toBeLessThan(0.0011);
      expect(y).toBeLessThanOrEqual(Math.max(0, x - BLOOM_THRESHOLD + BLOOM_KNEE));
      prev = y;
    }
    expect(bloomPrefilter(3)).toBeCloseTo(3 - BLOOM_THRESHOLD, 9);
  });
});

describe("circleOfConfusion (thin lens, signed: near < 0 < far)", () => {
  it("is 0 in focus, negative in front of the focal plane and positive behind it", () => {
    expect(circleOfConfusion(5, 5, 4, 10)).toBe(0);
    expect(circleOfConfusion(6, 5, 4, 10)).toBeGreaterThan(0);
    expect(circleOfConfusion(4, 5, 4, 10)).toBeLessThan(0);
    expect(circleOfConfusion(9, 5, 4, 10)).toBeGreaterThan(circleOfConfusion(6, 5, 4, 10));
    expect(circleOfConfusion(2, 5, 4, 10)).toBeLessThan(circleOfConfusion(4, 5, 4, 10));
  });

  it("tends to the aperture far away, and is capped up close", () => {
    expect(circleOfConfusion(1e9, 5, 4, 10)).toBeCloseTo(4, 6);
    expect(circleOfConfusion(0.1, 5, 4, 10)).toBe(-10);
  });

  it("is 0 everywhere with the aperture shut", () => {
    for (const z of [0.5, 3, 40]) expect(circleOfConfusion(z, 5, 0, 10)).toBe(0);
  });
});

describe("createFocus (focus follows the subject, eased; Reduce motion: no focus pulling)", () => {
  it("starts where it's told", () => {
    expect(createFocus(7).distance).toBe(7);
  });

  it("eases to a new target from rest, without overshoot, settled within 3 s", () => {
    const f = createFocus(4);
    const path = [];
    for (let k = 0; k < 180; k++) path.push(f.step(10, 1 / 60, false));
    expect(path[0] - 4).toBeLessThan(0.01);
    for (let k = 1; k < path.length; k++) {
      expect(path[k]).toBeGreaterThanOrEqual(path[k - 1]);
      expect(path[k]).toBeLessThanOrEqual(10);
    }
    expect(path.at(-1)).toBeGreaterThan(9.9);
  });

  it("is the same path whatever the frame rate", () => {
    const a = createFocus(2);
    const b = createFocus(2);
    for (let k = 0; k < 60; k++) a.step(6, 1 / 60, false);
    for (let k = 0; k < 144; k++) b.step(6, 1 / 144, false);
    expect(a.distance).toBeCloseTo(b.distance, 6);
  });

  it("holds still under Reduce motion, and resumes from rest after", () => {
    const f = createFocus(3);
    for (let k = 0; k < 30; k++) f.step(8, 1 / 60, false);
    const held = f.distance;
    for (let k = 0; k < 120; k++) expect(f.step(1, 1 / 60, true)).toBe(held);
    const next = f.step(held + 5, 1 / 60, false);
    expect(next - held).toBeLessThan(0.01);
  });

  it("jumps to the target on reset (a new camera: no pull across the cut)", () => {
    const f = createFocus(3);
    f.step(9, 1 / 60, false);
    f.reset(5);
    expect(f.distance).toBe(5);
    expect(f.step(5, 1 / 60, false)).toBe(5);
  });
});

describe("lookSamples (per Quality: AO directions × steps, depth-of-field taps, shadow steps)", () => {
  it("gives fewer samples at lower Quality, never more than the shaders' loop caps", () => {
    const lo = lookSamples("low");
    const md = lookSamples("medium");
    const hi = lookSamples("high");
    for (const k of /** @type {const} */ (["aoDirs", "aoSteps", "dofTaps", "shadow"])) {
      expect(lo[k]).toBeLessThanOrEqual(md[k]);
      expect(md[k]).toBeLessThanOrEqual(hi[k]);
      expect(hi[k]).toBeLessThanOrEqual(SAMPLE_CAPS[k]);
      expect(lo[k]).toBeGreaterThan(0);
    }
    expect(lo.aoDirs * lo.aoSteps).toBeLessThan(hi.aoDirs * hi.aoSteps);
    expect(lo.dofTaps).toBeLessThan(hi.dofTaps);
  });

  it("takes the Quality default (high) for an unknown value", () => {
    expect(lookSamples("no-such")).toEqual(lookSamples("high"));
  });

  it("returns a shared frozen table (nothing allocated per frame)", () => {
    expect(lookSamples("medium")).toBe(lookSamples("medium"));
    expect(Object.isFrozen(lookSamples("medium"))).toBe(true);
  });
});

describe("focus subjects", () => {
  it("sphereWallAhead: the unit sphere's wall straight ahead of an eye inside it", () => {
    expect(sphereWallAhead(0, 0, 0, 0, 0, 1)).toBeCloseTo(1, 12);
    expect(sphereWallAhead(0, 0, 0.5, 0, 0, 1)).toBeCloseTo(0.5, 12);
    expect(sphereWallAhead(0, 0, 0.5, 0, 0, -1)).toBeCloseTo(1.5, 12);
    // off the axis: the hit is on the sphere
    const t = sphereWallAhead(0.3, -0.2, 0.1, 0.6, 0.8, 0);
    expect(Math.hypot(0.3 + 0.6 * t, -0.2 + 0.8 * t, 0.1)).toBeCloseTo(1, 12);
  });

  it("sphereWallAhead: outside, the near side of the sphere along the view (or its centre's depth)", () => {
    expect(sphereWallAhead(0, 0, -3, 0, 0, 1)).toBeCloseTo(2, 12);
    // a view that misses the sphere focuses at the centre's depth
    expect(sphereWallAhead(0, 0, -3, 1, 0, 0)).toBeCloseTo(0, 12);
    expect(sphereWallAhead(0, 0, -3, 0.6, 0, 0.8)).toBeCloseTo(3 * 0.8, 12);
  });

  it("tubeWallAhead: from the torus's centre circle, along its tangent, to the outer wall", () => {
    for (const k of [0.2, 0.36, 0.5]) {
      const t = tubeWallAhead(k);
      // the point t along the tangent from (1, 0) is 1 + k from the ring's axis
      expect(Math.hypot(1, t)).toBeCloseTo(1 + k, 12);
    }
    expect(tubeWallAhead(0.5)).toBeGreaterThan(tubeWallAhead(0.2));
  });
});
