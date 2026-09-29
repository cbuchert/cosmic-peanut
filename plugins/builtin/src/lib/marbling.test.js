// @ts-check
import { describe, expect, it } from "vitest";
import { createMarbler, EV_DROP, MAX_EVENTS, createRng, clampDrag, PALETTES, paletteOf, REGIONS, strongestRegion, dragForward, dragInverse, dropForward, dropInverse } from "./marbling.js";

const out = new Float64Array(2);

describe("drop", () => {
  it("pushes a point radially outward so that |p' - c|² = |p - c|² + r²", () => {
    dropForward(0.5, 0.5, 0.01, 0.8, 0.5, out);
    expect(out[0]).toBeCloseTo(0.5 + Math.sqrt(0.3 ** 2 + 0.01), 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
  });

  it("inverts exactly: forward then inverse is the identity everywhere outside the drop", () => {
    const back = new Float64Array(2);
    for (let i = 0; i < 200; i++) {
      const px = (i * 0.618) % 1.7;
      const py = (i * 0.414) % 1;
      dropForward(0.9, 0.4, 0.02, px, py, out);
      expect(dropInverse(0.9, 0.4, 0.02, out[0], out[1], back)).toBe(false);
      expect(back[0]).toBeCloseTo(px, 9);
      expect(back[1]).toBeCloseTo(py, 9);
    }
  });

  it("reports points inside the new drop (they take the drop's paint, not a pre-image)", () => {
    const back = new Float64Array(2);
    expect(dropInverse(0.5, 0.5, 0.01, 0.55, 0.52, back)).toBe(true);
    expect(dropInverse(0.5, 0.5, 0.01, 0.62, 0.5, back)).toBe(false);
  });
});

describe("drop area", () => {
  it("moves every outside point outward and maps an annulus to one of equal area", () => {
    const r2 = 0.004;
    for (const [a, b] of [[0.05, 0.08], [0.2, 0.3]]) {
      const ra = dropForward(0, 0, r2, a, 0, out)[0];
      const rb = dropForward(0, 0, r2, 0, b, out)[1];
      expect(ra).toBeGreaterThan(a);
      expect(rb * rb - ra * ra).toBeCloseTo(b * b - a * a, 12);
    }
  });
});

describe("stylus drag", () => {
  const invS2 = 1 / 0.03 ** 2;
  it("drags paint at the stylus along its motion, falling off with distance", () => {
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.5, out);
    expect(out[0]).toBeCloseTo(0.51, 12);
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.53, out);
    expect(out[0] - 0.5).toBeCloseTo(0.01 * Math.exp(-1), 12);
    dragForward(0.5, 0.5, 0.01, 0, invS2, 0.5, 0.8, out);
    expect(out[0] - 0.5).toBeLessThan(1e-12);
  });

  it("clamps the motion so the map stays invertible, and the inverse round-trips", () => {
    const v = new Float64Array([0.5, 0.2]);
    clampDrag(invS2, v);
    const lim = 0.25 / Math.sqrt((2 * invS2) / Math.E);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(lim, 12);
    const back = new Float64Array(2);
    for (let i = 0; i < 200; i++) {
      const px = 0.45 + (i % 20) * 0.005;
      const py = 0.45 + Math.floor(i / 20) * 0.01;
      dragForward(0.5, 0.5, v[0], v[1], invS2, px, py, out);
      dragInverse(0.5, 0.5, v[0], v[1], invS2, out[0], out[1], back);
      expect(Math.abs(back[0] - px)).toBeLessThan(1e-4 * lim);
      expect(Math.abs(back[1] - py)).toBeLessThan(1e-4 * lim);
    }
  });

  it("leaves a small motion unclamped", () => {
    const v = new Float64Array([0.001, 0]);
    clampDrag(invS2, v);
    expect(v[0]).toBe(0.001);
  });
});


describe("createRng", () => {
  it("is a deterministic 0–1 stream per seed", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 50 }, () => c()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("strongestRegion", () => {
  /** @param {number} lo @param {number} hi @param {number} v */
  const hit = (lo, hi, v) => {
    const b = new Float32Array(64).fill(0.2);
    for (let i = lo; i < hi; i++) b[i] += v;
    return b;
  };
  const prev = new Float32Array(64).fill(0.2);

  it("splits the 64 log bands into low (<150 Hz), mid and high (>2 kHz)", () => {
    expect(REGIONS).toEqual([0, 17, 43, 64]);
  });

  it("picks the region whose bands rose most since the last frame", () => {
    expect(strongestRegion(hit(0, 6, 0.5), prev)).toBe(0); // kick
    expect(strongestRegion(hit(20, 40, 0.3), prev)).toBe(1); // snare body
    expect(strongestRegion(hit(48, 64, 0.2), prev)).toBe(2); // hats
  });

  it("measures the rise per band, so a narrow kick beats a wide faint wash", () => {
    const b = hit(0, 4, 0.6);
    for (let i = 43; i < 64; i++) b[i] += 0.05;
    expect(strongestRegion(b, prev)).toBe(0);
  });
});

describe("palettes", () => {
  /** @param {number[]} c */
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  it("offers beast (default), indigo, emerald and gold, each a paper and four inks", () => {
    expect(Object.keys(PALETTES)).toEqual(["beast", "indigo", "emerald", "gold"]);
    for (const p of Object.values(PALETTES)) {
      expect(p.paper).toHaveLength(3);
      expect(p.inks).toHaveLength(4);
      expect(lum(p.paper)).toBeGreaterThan(0.75); // cream paper
      expect(lum(p.inks[0])).toBeLessThan(0.08); // ink 0: the dark veins
      for (const c of p.inks) for (const v of c) expect(v >= 0 && v <= 1).toBe(true);
    }
  });

  it("beast is vermilion cells on black veins", () => {
    const [, body, light, deep] = PALETTES.beast.inks;
    for (const c of [body, light, deep]) expect(c[0]).toBeGreaterThan(2 * Math.max(c[1], c[2]) - 0.05);
    expect(lum(light)).toBeGreaterThan(lum(body));
    expect(lum(deep)).toBeLessThan(lum(body));
  });

  it("falls back to beast for an unknown name", () => {
    expect(paletteOf("nope")).toBe(PALETTES.beast);
    expect(paletteOf("gold")).toBe(PALETTES.gold);
  });
});

/** A quiet, silent-ish audio frame; override fields per test. */
function audioFrame(o = {}) {
  return {
    onset: false,
    onsetStrength: 0,
    bands: new Float32Array(64),
    bassAtt: 1,
    rms: 0,
    peak: 0,
    centroid: 0.1,
    silent: false,
    ...o,
  };
}
/** @param {number} lo @param {number} hi */
function bandsHit(lo, hi) {
  const b = new Float32Array(64);
  for (let i = lo; i < hi; i++) b[i] = 0.8;
  return b;
}
const PARAMS = { pour: 1, size: 1, rake: 0, reactivity: 1, renew: 0 };
const ENV = { aspect: 16 / 9, pxPerUnit: 1440, reduceFlashing: true, reduceMotion: false };
const DT = 1 / 60;

/** Squared radii of the DROP events of the marbler's current frame. */
function dropsOf(m) {
  const out = [];
  for (let i = 0; i < m.count; i++) if (m.evA[i * 4] === EV_DROP) out.push(m.evA[i * 4 + 3]);
  return out;
}

describe("createMarbler", () => {
  it("pours nothing into a silent bath", () => {
    const m = createMarbler(1);
    for (let i = 0; i < 120; i++) m.step(audioFrame({ silent: true }), DT, PARAMS, ENV);
    expect(m.count).toBe(0);
  });

  it("drops paint on an onset; a kick leaves a bigger drop than a hat", () => {
    const total = (/** @type {number} */ lo, /** @type {number} */ hi) => {
      const m = createMarbler(1);
      m.step(audioFrame(), DT, PARAMS, ENV);
      m.step(audioFrame({ onset: true, onsetStrength: 1, bands: bandsHit(lo, hi) }), DT, PARAMS, ENV);
      let r2 = 0;
      for (let i = 0; i < 30; i++) {
        r2 += dropsOf(m).reduce((a, b) => a + b, 0);
        m.step(audioFrame(), DT, PARAMS, ENV);
      }
      return r2;
    };
    const kick = total(0, 6);
    const hat = total(48, 64);
    expect(kick).toBeGreaterThan(0);
    expect(hat).toBeGreaterThan(0);
    expect(kick).toBeGreaterThan(4 * hat);
    expect(MAX_EVENTS).toBe(16);
  });

  it("pours a drop over several frames as concentric slices: vein rim first, then the cell", () => {
    const m = createMarbler(3);
    m.step(audioFrame(), DT, PARAMS, ENV);
    m.step(audioFrame({ onset: true, onsetStrength: 1, bands: bandsHit(0, 6) }), DT, PARAMS, ENV);
    let total = 0;
    let cell = 0;
    let frames = 0;
    let first = true;
    const px = m.evA[1];
    // Event 0 is the kick while it pours (satellites queue in later slots and land after it).
    while (m.count > 0 && m.evA[1] === px) {
      const slice = m.evA[3];
      const cellPart = m.evB[0];
      if (first) expect(cellPart).toBeLessThan(slice); // the rim goes in first
      first = false;
      expect(m.evD[0]).toBe(1); // rim ink 0 = veins
      expect(m.evC[1]).toBe(1); // kick cells are ink 1, the body colour
      total += slice;
      cell += cellPart;
      frames++;
      m.step(audioFrame(), DT, PARAMS, ENV);
    }
    expect(frames).toBeGreaterThan(5); // it spreads, it doesn't pop
    expect(Math.sqrt(total) - Math.sqrt(cell)).toBeCloseTo(0.0035, 6);
  });

  it("follows a kick with smaller satellite drops inside it (nested cells)", () => {
    let seen = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const m = createMarbler(seed);
      m.step(audioFrame(), DT, PARAMS, ENV);
      m.step(audioFrame({ onset: true, onsetStrength: 1, bands: bandsHit(0, 6) }), DT, PARAMS, ENV);
      const px = m.evA[1];
      const py = m.evA[2];
      let parent2 = 0;
      for (let f = 0; f < 60; f++) {
        for (let i = 0; i < m.count; i++) {
          const x = m.evA[i * 4 + 1];
          const y = m.evA[i * 4 + 2];
          if (x === px && y === py) {
            parent2 += m.evA[i * 4 + 3];
            continue;
          }
          seen++;
          expect(Math.hypot(x - px, y - py)).toBeLessThan(0.5 * Math.sqrt(parent2));
          expect(m.evC[i * 4 + 2] + m.evC[i * 4 + 3]).toBe(1); // light or deep ink
        }
        m.step(audioFrame(), DT, PARAMS, ENV);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("pours faster when the music is loud, and never emits more than MAX_EVENTS a frame", () => {
    const poured = (/** @type {number} */ rms) => {
      const m = createMarbler(5);
      let drops = 0;
      for (let f = 0; f < 600; f++) {
        const onset = f % 6 === 0; // a flood of hits (10/s)
        const lo = (f * 7) % 48;
        m.step(audioFrame({ rms, onset, onsetStrength: 1, bands: bandsHit(lo, lo + 16) }), DT, PARAMS, ENV);
        expect(m.count).toBeLessThanOrEqual(MAX_EVENTS);
        for (let i = 0; i < m.count; i++) if (m.evA[i * 4] === EV_DROP) drops++;
      }
      return drops;
    };
    expect(poured(0.3)).toBeGreaterThan(1.8 * poured(0.02));
  });
});

