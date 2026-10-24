// @ts-check
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a Node builtin (tests run in Node); the web tsconfig has no @types/node.
import { readFileSync } from "node:fs";
import { createTessState, LIFT_BINS, LIFT_GAIN, LIFT_VARY, RELIEF_DEFAULT, tileFade } from "./tess-music.js";
import { CARD_HALF, CARD_RISE, cardHeight, createTile, fieldAt, groupOf, RELIEF_BLOCK, reliefHeight, reliefProfile, tileAt } from "./tess.js";
import { latticeCounts, mapParams, minorFraction, planePoint, THICKNESS, twistTurns } from "./torus.js";
import { bakeHeight, cellKey, jacobianNorm, localCeiling, planeSlope, POP_BAND, RING_REACH, ringRange, ringWindow, STEP_REACH, RELIEF_CAP, RELIEF_SCALE, reliefScale, reliefShell, reliefSlope, reliefStep, reliefWorld, SLOPE_CAP, WARP_LOG_SLOPE } from "./torus-relief.js";
import { COLS, createWaveHistory, dispAt, liveDisp, maxDisp, ROWS, stepFactor, waveAmp, waveSlope } from "./torus-wave.js";

describe("relief params", () => {
  it("maps Relief (0–1, default 0.6) and Light (degrees 0–360, default 135)", () => {
    expect(mapParams({}, {})).toMatchObject({ relief: 0.6, light: 135 });
    expect(mapParams({ relief: 1.7, light: 400 }, {})).toMatchObject({ relief: 1, light: 360 });
    expect(mapParams({ relief: -1, light: -5 }, {})).toMatchObject({ relief: 0, light: 0 });
    expect(mapParams({ relief: "x", light: "y" }, {})).toMatchObject({ relief: 0.6, light: 135 });
    expect(mapParams({ relief: 0, light: 200 }, {})).toMatchObject({ relief: 0, light: 200 });
  });
});

describe("cell key: each tile's lift and pop hash closes round the torus", () => {
  const c = { nu: 0, nv: 0, lx: 0, ly: 0 };
  const key = [0, 0];
  const key2 = [0, 0];
  for (const g of ["p4", "p3"]) {
    it(`is the same for a tile and its copies one lap round the ring and round the tube (${g}, with twist)`, () => {
      for (const k of [0.2, 0.36, 0.5]) {
        latticeCounts(g, k, c);
        for (const half of [0, 0.5, 1, 2]) {
          const tw = twistTurns(half, c.nv);
          // T1 = (lx, tw ly) (round the ring), T2 = (0, ly) (round the tube), as shader cells.
          const t1 = g === "p4" ? [2 * c.lx, Math.round(2 * tw * c.ly)] : [3 * (c.nu - Math.round(tw * c.nv)), 6 * Math.round(tw * c.nv)];
          const t2 = g === "p4" ? [0, 2 * c.ly] : [-3 * c.nv, 6 * c.nv];
          for (let i = 0; i < 400; i++) {
            const cell = g === "p4" ? [((i * 37) % 97) - 40, ((i * 53) % 61) - 25] : [3 * (((i * 37) % 97) - 40) + (i % 3), 3 * (((i * 53) % 61) - 25)];
            cellKey(g, cell[0], cell[1], c, tw, key);
            for (const [m1, m2] of [[1, 0], [-1, 0], [0, 1], [0, -2], [2, -1], [-3, 3]]) {
              cellKey(g, cell[0] + m1 * t1[0] + m2 * t2[0], cell[1] + m1 * t1[1] + m2 * t2[1], c, tw, key2);
              expect(key2).toEqual(key);
            }
            // The key is the copy in one fundamental domain, so tiles of one lap keep their own
            // cells (the hash still varies tile to tile) and their keys there are themselves.
            if (g === "p4") {
              expect(key[0]).toBeGreaterThanOrEqual(0);
              expect(key[0]).toBeLessThan(2 * c.lx);
              expect(key[1]).toBeGreaterThanOrEqual(0);
              expect(key[1]).toBeLessThan(2 * c.ly);
            } else {
              const la = Math.floor(key[0] / 3);
              const lb = key[1] / 3;
              expect(la + lb / 2).toBeGreaterThanOrEqual(0);
              expect(la + lb / 2).toBeLessThan(c.nu);
              expect(lb).toBeGreaterThanOrEqual(0);
              expect(lb).toBeLessThan(2 * c.nv);
            }
            cellKey(g, key[0], key[1], c, tw, key2);
            expect(key2).toEqual(key);
          }
        }
      }
    });
  }

  it("matches the real tiles either side of the seam θ = ±π (warped, spin and twist)", () => {
    const pa = [0, 0];
    const pb = [0, 0];
    const d = [0, 0];
    const t = createTile();
    for (const g of ["p4", "p3"]) {
      const grp = groupOf(g);
      const s = warpedState(g);
      const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
      latticeCounts(g, 0.36, c);
      for (const half of [0, 1, 2]) {
        const tw = twistTurns(half, c.nv);
        for (let i = 0; i < 40; i++) {
          const phi = -3 + i * 0.15;
          // fu, fv keep the plane (and p3 lattice) coordinates positive: the test reads cells from tile ids
          planePoint(-Math.PI, phi, 0.36, c, 2.6 + i * 0.01, 1.2 + i * 0.013, pa, tw);
          planePoint(Math.PI, phi, 0.36, c, 2.6 + i * 0.01, 1.2 + i * 0.013, pb, tw);
          const ca = shaderCell(grp, s, blend, pa, d, t);
          const cb = shaderCell(grp, s, blend, pb, d, t);
          cellKey(g, ca[0], ca[1], c, tw, key);
          cellKey(g, cb[0], cb[1], c, tw, key2);
          expect(cb).not.toEqual(ca);
          expect(key2).toEqual(key);
        }
      }
    }
  });
});

/** @typedef {ReturnType<typeof groupOf>} Group @typedef {ReturnType<typeof createTessState>} State
 * @typedef {{ kx: number, ky: number, phase: number }} Blend @typedef {ReturnType<typeof createTile>} Tile
 * @typedef {{ nu: number, nv: number, lx: number, ly: number }} Counts
 * @typedef {{ relief: number, profile: number, lift: number, pop: number, cards: number, theta: number, key?: { g: string, c: Counts, tw: number } }} Music */
/** A state morphed towards one family (the centroid picks it), every seed a different warp. */
function morphedState(/** @type {string} */ g, /** @type {number} */ seed) {
  const s = createTessState();
  const audio = { bands: new Float32Array(64).fill(0.5), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.03 + 0.025 * seed, bassAtt: 1.2, silent: false };
  const o = { symmetry: g, palette: "ink", reactivity: 1, speed: 1, morph: seed % 2 ? 1 : 0.7, ink: 1, hatching: 0.6, height: 1440, reduceMotion: false, reduceFlashing: false };
  for (let i = 0; i < 300 * (seed + 1); i++) {
    audio.beatPhase = (i / 30) % 1;
    audio.onset = i % 30 === 0;
    audio.onsetStrength = audio.onset ? 0.9 : 0;
    s.step(audio, 1 / 60, o);
  }
  return s;
}

/** A state with a real warp mid-morph (both sets non-zero, blend drifted). */
function warpedState(/** @type {string} */ symmetry) {
  const s = createTessState();
  const audio = { bands: new Float32Array(64).fill(0.5), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.2, bassAtt: 1.2, silent: false };
  const o = { symmetry, palette: "ink", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, height: 1440, reduceMotion: false, reduceFlashing: false };
  for (let i = 0; i < 600; i++) {
    audio.beatPhase = (i / 30) % 1;
    s.step(audio, 1 / 60, o);
  }
  return s;
}

/**
 * The shader's Tile.cell at plane point p (tess.glsl tessTile after four warp steps): p4 the
 * half-unit square (i, j); p3 3 × the lattice point + (class, 0). Read from lib/tess.js tile ids
 * (positive coordinates only).
 */
/** @param {Group} grp @param {State} s @param {Blend} blend @param {number[]} p @param {number[]} d @param {Tile} t */
function shaderCell(grp, s, blend, p, d, t) {
  let x = p[0];
  let y = p[1];
  for (let k = 0; k < 4; k++) {
    fieldAt(grp, s.ab, blend, x, y, d);
    x += d[0];
    y += d[1];
  }
  tileAt(grp, x, y, t);
  if (grp.order === 4) return [Math.floor(t.id / 100003), t.id % 100003];
  const k = t.id % 3;
  const ab = (t.id - k) / 3;
  return [3 * Math.floor(ab / 100003) + k, 3 * (ab % 100003)];
}

describe("relief in world units", () => {
  const c = { nu: 0, nv: 0, lx: 0, ly: 0 };
  it("scales the block with the local tile size (tiles are bigger on the outer equator), up to the cap", () => {
    for (const k of [THICKNESS.min, 0.36, THICKNESS.max]) {
      latticeCounts("p4", k, c);
      for (let i = 0; i < 50; i++) {
        const phi = -Math.PI + (i / 49) * 2 * Math.PI;
        const tile = (2 * Math.PI * (1 + k * Math.cos(phi))) / c.lx; // a plane unit, world
        expect(reliefScale(phi, k, c.lx)).toBeCloseTo(RELIEF_SCALE * tile, 12);
        expect(reliefWorld(0.05, phi, k, c.lx)).toBeCloseTo(0.05 * RELIEF_SCALE * tile, 12);
        expect(reliefWorld(10, phi, k, c.lx)).toBe(RELIEF_CAP * k);
        expect(reliefWorld(0, phi, k, c.lx)).toBe(0);
      }
    }
  });

  it("is clearly visible: at the defaults a bar's beat lifts an outer tile by a fifth of its width", () => {
    latticeCounts("p4", THICKNESS.default, c);
    const tile = (0.5 * 2 * Math.PI * (1 + THICKNESS.default)) / c.lx; // a p4 tile is half a unit
    const lift = reliefWorld(RELIEF_DEFAULT * LIFT_GAIN, 0, THICKNESS.default, c.lx);
    expect(lift).toBeGreaterThanOrEqual(0.2 * tile);
    expect(lift).toBeLessThan(RELIEF_CAP * THICKNESS.default); // not flattened by the cap
  });

  it("knows the thickest relief now (the march's shell), from the engine's height bound", () => {
    for (const k of [THICKNESS.min, 0.36, THICKNESS.max]) {
      latticeCounts("p3", k, c);
      for (const hMax of [0, 0.02, 0.1, 0.3, 2]) {
        const D = reliefShell(hMax, k, c.lx);
        let top = 0;
        for (let i = 0; i <= 200; i++) {
          const phi = -Math.PI + (i / 200) * 2 * Math.PI; // includes the outer equator, φ = 0
          for (const h of [0, hMax / 3, hMax]) top = Math.max(top, reliefWorld(h, phi, k, c.lx));
        }
        expect(D).toBeGreaterThanOrEqual(top);
        expect(D).toBeCloseTo(top, 9); // tight: the outer equator at the bound
      }
    }
  });

  it("leaves the inside camera clear of the walls with the tallest waves and relief (≥ 0.3 k)", () => {
    for (let i = 0; i <= 30; i++) {
      const k = THICKNESS.min + (i / 30) * (THICKNESS.max - THICKNESS.min);
      latticeCounts("p4", k, c);
      // The fly path rides the tube's centre circle; the walls come inward by the waves' largest
      // displacement and the relief's (raised towards the camera inside), whatever the music.
      const nearest = k - maxDisp(1, k) - reliefShell(1e3, k, c.lx);
      expect(nearest).toBeGreaterThanOrEqual(0.3 * k - 1e-12);
    }
  });
});

/** The tile's centre in the warped tile plane (tess.glsl Tile.centre), from its lib/tess.js id. */
/** @param {Group} grp @param {Tile} t @param {number[]} out */
function tileCentre(grp, t, out) {
  if (grp.order === 4) {
    const i = Math.floor(t.id / 100003);
    const j = t.id % 100003;
    const pi = ((i % 2) + 2) % 2;
    const pj = ((j % 2) + 2) % 2;
    const a = (t.orient * Math.PI) / 2;
    out[0] = (i + pi) / 2 + 0.25 * (Math.cos(a) - Math.sin(a));
    out[1] = (j + pj) / 2 + 0.25 * (Math.sin(a) + Math.cos(a));
    return out;
  }
  const k = t.id % 3;
  const ab = (t.id - k) / 3;
  const la = Math.floor(ab / 100003);
  const lb = ab % 100003;
  const a = (k * 2 * Math.PI) / 3;
  const r = 0.5 / Math.sqrt(3);
  out[0] = la + lb / 2 - Math.sin(a) * r;
  out[1] = (lb * Math.sqrt(3)) / 2 + Math.cos(a) * r;
  return out;
}

/**
 * The height pass at plane point (x, y), mirrored from torus.frag's TESS_HEIGHT_PASS on
 * lib/tess.js: the warp (four steps, J = dq/dp by differences), the tile, the block (relief ×
 * profile), a lift per tile (hashed: beat waves, heave and pops leave neighbours at different
 * heights, the cliffs a sphere tracer can't take) and, for some tiles, a card turning by θ about
 * an axis across the ring (b = x, the torus's TESS_FLIP_DIR) as tessPlate draws it: squeezed by
 * |cos θ| across the axis (the tile at the card's own point; the bare bed outside), tilted. `cap`
 * applies bakeHeight with the tile distance over ‖C J‖; without it the raw block. Plane points
 * must keep the p3 lattice coordinates positive (the centre comes from the tile id).
 */
/** @param {Group} grp @param {State} s @param {Blend} blend @param {number} x @param {number} y @param {Music} o @param {Tile} t */
function bakeMirror(grp, s, blend, x, y, o, t, cap = true) {
  const q = [0, 0];
  const qx = [0, 0];
  const qy = [0, 0];
  const d = [0, 0];
  const cen = [0, 0];
  const warp = (/** @type {number} */ px, /** @type {number} */ py, /** @type {number[]} */ out) => {
    out[0] = px;
    out[1] = py;
    for (let k = 0; k < 4; k++) {
      fieldAt(grp, s.ab, blend, out[0], out[1], d);
      out[0] += d[0];
      out[1] += d[1];
    }
    return out;
  };
  const e = 1e-6;
  warp(x, y, q);
  warp(x + e, y, qx);
  warp(x, y + e, qy);
  // J = dq/dp, columns (∂q/∂x, ∂q/∂y)
  let a = (qx[0] - q[0]) / e;
  const b = (qx[1] - q[1]) / e;
  let c = (qy[0] - q[0]) / e;
  const dd = (qy[1] - q[1]) / e;
  tileAt(grp, q[0], q[1], t);
  const hash = (/** @type {number} */ n) => {
    const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  let r = hash(t.id);
  if (o.key) {
    const cell = grp.order === 4 ? [Math.floor(t.id / 100003), t.id % 100003] : [3 * Math.floor((t.id - (t.id % 3)) / 3 / 100003) + (t.id % 3), 3 * (((t.id - (t.id % 3)) / 3) % 100003)];
    const kk = cellKey(o.key.g, cell[0], cell[1], o.key.c, o.key.tw, [0, 0]);
    r = hash(kk[0] * 1009 + kk[1]);
  }
  const lift = o.relief * (o.lift * r + (r > 0.85 ? o.pop : 0));
  let h = lift + o.relief * RELIEF_BLOCK * reliefProfile(t.dist, o.profile);
  if (r < o.cards) {
    const ac = Math.max(Math.abs(Math.cos(o.theta)), 0.02);
    tileCentre(grp, t, cen);
    const xa = q[0] - cen[0];
    const xc = xa / ac;
    const id = t.id;
    tileAt(grp, q[0] + (xc - xa), q[1], t);
    if (t.id !== id) return 0; // the bare bed
    h = lift + o.relief * RELIEF_BLOCK * ac * reliefProfile(t.dist, o.profile) + cardHeight(xc, o.theta, 0.08);
    a /= ac; // C = I + b bᵀ (1/|cos θ| − 1), b = x
    c /= ac;
  }
  return cap ? bakeHeight(h, t.dist, jacobianNorm(a, b, c, dd), false) : h;
}

describe("baked relief: the block's cliffs become slopes the march can take", () => {
  const tile = createTile();
  const music = { relief: 1, profile: 0.35, lift: 0.3, pop: 0.12, cards: 0.15, theta: 1.45 };
  for (const g of ["p4", "p3"]) {
    it(`keeps the plane slope within planeSlope(the tallest block), lifts, pops and cards included (${g})`, () => {
      const grp = groupOf(g);
      const step = 0.004;
      const n = 160;
      const row = new Float64Array(n);
      const rawRow = new Float64Array(n);
      let excess = 0;
      let cliffs = 0;
      for (const seed of [0, 3, 6]) {
        const s = morphedState(g, seed);
        const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
        for (const music of [
          { relief: 0.6, profile: 0.35, lift: 0.15, pop: 0.04, cards: 0.1, theta: 1.0 },
          { relief: 1, profile: 0.35, lift: 0.3, pop: 0.12, cards: 0.15, theta: 1.45 },
        ]) {
          let capped = 0;
          let raw = 0;
          let top = 0;
          for (let j = 0; j < n; j++) {
            let prev = 0;
            let prevRaw = 0;
            for (let i = 0; i < n; i++) {
              const x = 3.31 + i * step;
              const y = 0.17 + j * step;
              const h = bakeMirror(grp, s, blend, x, y, music, tile);
              const hr = bakeMirror(grp, s, blend, x, y, music, tile, false);
              expect(h).toBeGreaterThanOrEqual(0);
              expect(h).toBeLessThanOrEqual(hr + 1e-12); // the cap only ever lowers the block
              top = Math.max(top, hr);
              if (i > 0) {
                capped = Math.max(capped, Math.abs(h - prev) / step);
                raw = Math.max(raw, Math.abs(hr - prevRaw) / step);
              }
              if (j > 0) {
                capped = Math.max(capped, Math.abs(h - row[i]) / step);
                raw = Math.max(raw, Math.abs(hr - rawRow[i]) / step);
              }
              prev = h;
              prevRaw = hr;
              row[i] = h;
              rawRow[i] = hr;
            }
          }
          cliffs = Math.max(cliffs, raw);
          expect(capped).toBeLessThanOrEqual(planeSlope(top));
          excess = Math.max(excess, (capped - SLOPE_CAP) / top);
        }
      }
      expect(cliffs).toBeGreaterThan(10 * SLOPE_CAP); // the cliffs are there without the cap
      expect(excess).toBeLessThanOrEqual(WARP_LOG_SLOPE / 1.25);
      expect(excess).toBeGreaterThan(0); // (the warp's stretch does lean the cut sides more)
    });
  }

  it("leaves a resting block's top and a lifted tile's top alone (only the cut sides lean)", () => {
    expect(jacobianNorm(2, 0, 0, 0.5)).toBeCloseTo(2, 12);
    expect(jacobianNorm(0, 3, -1, 0)).toBeCloseTo(3, 12);
    expect(jacobianNorm(1, 1, -1, 1)).toBeCloseTo(Math.SQRT2, 12); // a turn and a scale
    expect(bakeHeight(0.05, 0.2, 1, false)).toBe(0.05);
    expect(bakeHeight(0.05, 0, 1, false)).toBe(0);
    expect(bakeHeight(0.05, 0.01, 1, false)).toBeCloseTo(SLOPE_CAP * 0.01, 12);
    expect(bakeHeight(0.05, 0.01, 2, false)).toBeCloseTo((SLOPE_CAP * 0.01) / 2, 12);
    expect(bakeHeight(0.05, 0.2, 1, true)).toBe(0); // a card's bare bed
  });
});

describe("combined displacement: waves plus relief", () => {
  /** A wave history with real music in it (as torus-wave.test.js's). */
  const filledWaves = () => {
    const h = createWaveHistory(COLS, ROWS, () => {});
    const wave = new Float32Array(2048);
    for (let i = 0; i < 300; i++) {
      for (let j = 0; j < wave.length; j++) wave[j] = 0.5 * Math.sin((2 * Math.PI * j) / (90 + i)) + 0.2 * Math.sin(j * 0.37 + i);
      h.step(wave, 1 / 60, { travel: 2, detail: 0.4, env: i % 30 < 3 ? 1 : 0, bassAtt: 1.5, reactivity: 1 });
    }
    return h;
  };

  /** The height pass over the torus's (a, b) (lib/torus-relief.js), W × H texels, its tiles' hash by cellKey. */
  /** @param {string} g @param {State} s @param {Counts} c @param {number} tw @param {number} W @param {number} H @param {Music} music */
  function bakeTorus(g, s, c, tw, W, H, music) {
    const grp = groupOf(g);
    const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
    const map = new Float64Array(W * H);
    const t = createTile();
    let top = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        // a from 2, so plane (and p3 lattice) coordinates stay positive for the id decoding
        const a = 2 + (i + 0.5) / W;
        const b = (j + 0.5) / H;
        const x = c.lx * a;
        const y = c.ly * (b + tw * a);
        const hr = bakeMirror(grp, s, blend, x, y, { ...music, key: { g, c, tw } }, t, false);
        top = Math.max(top, hr);
        map[j * W + i] = bakeMirror(grp, s, blend, x, y, { ...music, key: { g, c, tw } }, t);
      }
    }
    return { map, W, H, top };
  }

  /** Bilinear, repeating (as a REPEAT texture with LINEAR filtering), at (a, b). */
  /** @param {{ map: Float64Array, W: number, H: number }} m @param {number} a @param {number} b */
  function sample(m, a, b) {
    const x = (a - Math.floor(a)) * m.W - 0.5;
    const y = (b - Math.floor(b)) * m.H - 0.5;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const fx = x - i0;
    const fy = y - j0;
    const at = (/** @type {number} */ i, /** @type {number} */ j) => m.map[(((j % m.H) + m.H) % m.H) * m.W + (((i % m.W) + m.W) % m.W)];
    return (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fy) + (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fy;
  }

  it("keeps the march's step at relief 0 exactly as before (the waves' own factor)", () => {
    const h = filledWaves();
    const amp = waveAmp(0.7, 0.36);
    expect(stepFactor(h, amp, 0.36, 0)).toBe(stepFactor(h, amp, 0.36));
    expect(waveSlope(h, amp, 0.36)).toBeCloseTo(Math.sqrt(1 / stepFactor(h, amp, 0.36) ** 2 - 1), 9);
    expect(waveSlope(createWaveHistory(COLS, ROWS, () => {}), amp, 0.36)).toBe(0);
  });

  for (const [g, half] of /** @type {[string, number][]} */ ([["p4", 0], ["p3", 1]])) {
    it(`bounds the step on the shell: the factor covers the real gradient, outside and inside (${g}, twist ${half})`, () => {
      const k = 0.36;
      const c = { nu: 0, nv: 0, lx: 0, ly: 0 };
      latticeCounts(g, k, c);
      const tw = twistTurns(half, c.nv);
      const s = warpedState(g);
      const music = { relief: 1, profile: 0.35, lift: 0.25, pop: 0.1, cards: 0.1, theta: 1.3 };
      const m = bakeTorus(g, s, c, tw, 480, 200, music);
      const hist = filledWaves();
      const amp = waveAmp(1, k);
      const Dw = liveDisp(hist, amp);
      const Dr = reliefShell(m.top, k, c.lx);
      const D = Dw + Dr;
      const gw = waveSlope(hist, amp, k, Dr);
      const gr = reliefSlope(m.top, k, c, tw, D);
      const K = reliefStep(gw, gr);
      expect(K).toBeGreaterThan(0.01); // the march still moves (Relief 1, every wave stacked)
      const fu = 0.137;
      const fv = 0.611;
      const off = (/** @type {number} */ th, /** @type {number} */ ph, /** @type {number} */ side) => {
        const a = th / (2 * Math.PI) + fu;
        const b = minorFraction(ph, k) + fv;
        return dispAt(hist, th, ph, amp) + side * reliefWorld(sample(m, a, b), ph, k, c.lx);
      };
      let worst = 0;
      const e = 2e-5;
      for (const side of [1, -1]) {
        for (const q of [k - D, k + D]) {
          for (let i = 0; i < 6000; i++) {
            const th = ((i * 0.61803) % 1) * 2 * Math.PI - Math.PI;
            const ph = ((i * 0.41421) % 1) * 2 * Math.PI - Math.PI;
            const rho = 1 + q * Math.cos(ph);
            const dth = (off(th + e, ph, side) - off(th - e, ph, side)) / (2 * e) / rho;
            const dph = (off(th, ph + e, side) - off(th, ph - e, side)) / (2 * e) / q;
            worst = Math.max(worst, Math.hypot(dth, dph));
          }
        }
      }
      expect(1 / Math.sqrt(1 + worst * worst)).toBeGreaterThanOrEqual(K);
      expect(worst).toBeGreaterThan(gw); // the relief's slope is really there
    });
  }

  it("closes the relief round the ring (θ = ±π) and round the tube (φ = ±π) with spin and twist", () => {
    const k = 0.36;
    for (const [g, half] of /** @type {[string, number][]} */ ([["p4", 0], ["p4", 2], ["p3", 1]])) {
      const c = { nu: 0, nv: 0, lx: 0, ly: 0 };
      latticeCounts(g, k, c);
      const tw = twistTurns(half, c.nv);
      const s = warpedState(g);
      const m = bakeTorus(g, s, c, tw, 240, 100, { relief: 1, profile: 0.35, lift: 0.25, pop: 0.1, cards: 0.1, theta: 1.3 });
      const grp = groupOf(g);
      const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
      const t = createTile();
      for (let i = 0; i < 40; i++) {
        const fu = 0.07 * i;
        const fv = 0.031 * i; // spin
        const ph = -Math.PI + 0.157 * i;
        const th = -Math.PI + 0.157 * i;
        // the map is sampled at (θ/2π + fu, t(φ) + fv): one lap is a whole step in a or b
        const a0 = -Math.PI / (2 * Math.PI) + fu;
        const a1 = Math.PI / (2 * Math.PI) + fu;
        expect(sample(m, a1, minorFraction(ph, k) + fv)).toBeCloseTo(sample(m, a0, minorFraction(ph, k) + fv), 12);
        const b0 = minorFraction(-Math.PI + 1e-12, k) + fv;
        const b1 = minorFraction(Math.PI, k) + fv;
        expect(sample(m, th / (2 * Math.PI) + fu, b1)).toBeCloseTo(sample(m, th / (2 * Math.PI) + fu, b0), 9);
        // and the block itself agrees across the ring's seam: the same tile and height
        const x0 = c.lx * (2 + a0);
        const y0 = c.ly * (minorFraction(ph, k) + fv + tw * (2 + a0));
        const h0 = bakeMirror(grp, s, blend, x0 + 1e-9, y0, { relief: 1, profile: 0.35, lift: 0.25, pop: 0.1, cards: 0, theta: 0, key: { g, c, tw } }, t);
        const h1 = bakeMirror(grp, s, blend, x0 + c.lx + 1e-9, y0 + tw * c.ly, { relief: 1, profile: 0.35, lift: 0.25, pop: 0.1, cards: 0, theta: 0, key: { g, c, tw } }, t);
        expect(h1).toBeCloseTo(h0, 6);
      }
    }
  });
});

describe("the relief on the surface (shaders/tess/torus.frag)", () => {
  const frag = readFileSync(new URL("../../shaders/tess/torus.frag", import.meta.url), "utf8");
  const engine = readFileSync(new URL("../../shaders/tess/tess.glsl", import.meta.url), "utf8");
  const disp = readFileSync(new URL("../../shaders/tess/torus-disp.frag", import.meta.url), "utf8");
  const before = frag.slice(0, frag.indexOf("// #include tess"));

  it("hashes each tile by its key (engine hook TESS_CELL_KEY, identity by default)", () => {
    expect(engine).toContain("#ifndef TESS_CELL_KEY\n#define TESS_CELL_KEY(cell) (cell)\n#endif");
    expect(engine).toContain("tessHash12(TESS_CELL_KEY(r.t.cell) * 0.731 + 3.7)");
    expect(engine).toContain("tessPopAt(TESS_CELL_KEY(r.t.cell), ring)");
    expect(engine).not.toMatch(/tessHash12\(r\.t\.cell|tessPopAt\(r\.t\.cell/);
    expect(before).toContain("#define TESS_CELL_KEY(cell) torusCellKey(cell)");
    expect(before).toContain("#define TESS_FLIP_DIR(c) torusFlipDir(c)");
    expect(before).toContain("#define TESS_RING(c) torusRing(c)");
  });

  it("bakes and samples the block over the tiles' own coordinates (they spin, the waves don't)", () => {
    expect(frag).toContain("TessPlate r = tessPlate(vec2(u_lxy.x * ab.x, u_lxy.y * (ab.y + u_twist * ab.x)));");
    expect(frag).toContain("vec2 reliefAB(float theta, float tf) { return vec2(theta / (2.0 * PI) + u_flow.x, tf + u_flow.y); }");
    // the cap as torus-relief.js's
    expect(frag).toContain(`#define RELIEF_SLOPE ${SLOPE_CAP.toFixed(1)}`);
    expect(frag).toContain("min(r.h, RELIEF_SLOPE * r.t.dist / max(jn, 1e-6))");
    expect(frag).toContain("float reliefW(float H, float cphi) { return min(u_rel.y, u_rel.x * (1.0 + u_k * cphi) * H); }");
    // the waves never see the spin, twist or relief
    expect(disp).not.toMatch(/u_flow|u_twist|u_tHeight/);
    for (const call of frag.match(/disp\([^;]*;/g) ?? []) expect(call).not.toMatch(/u_flow|u_twist|\bp\b|reliefAB/);
  });

  it("steps by the waves' bound above the relief's shell and by the combined one inside it", () => {
    expect(frag).toContain("if (f > u_rel.z + eps) {\n          r = (f - u_rel.z) * u_stepK;");
    expect(frag).toContain("float relUp = reliefW(min(reliefCeiling(th / (2.0 * PI) + u_flow.x), u_tRelief.z), 1.0);");
    expect(frag).toContain("r = min(u_relWin.y, (f - relUp) * u_stepK);");
    expect(frag).toContain("f -= relAt(th, ph);");
    // under the ceiling: the combined factor, for a budget of steps (outside then the waves')
    expect(frag).toContain("r = f * (near < RELIEF_STEPS_OUT ? u_rel.w : u_stepK);");
    expect(frag).toContain("if (u_side < 0.0 && near >= RELIEF_STEPS_IN) break;");
  });
});

describe("local ceiling of the block (the march's fast descent through the relief's shell)", () => {
  /** tess.glsl tessLiftAt. */
  const liftAt = (/** @type {Float32Array} */ lift, /** @type {number} */ ring) => {
    const x = Math.min(1, Math.max(0, ring)) * (LIFT_BINS - 1);
    const i = Math.min(Math.floor(x), LIFT_BINS - 2);
    return lift[i] + (lift[i + 1] - lift[i]) * (x - i);
  };

  it("mirrors the engine's pop band", () => {
    const engine = readFileSync(new URL("../../shaders/tess/tess.glsl", import.meta.url), "utf8");
    expect(engine).toContain(`#define POP_BAND ${POP_BAND}`);
  });

  it("is above every tile whose ring is in the window: lifts, heave, pops and turning cards (real music)", () => {
    const s = createTessState();
    const audio = { bands: new Float32Array(64), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.2, bassAtt: 1.4, silent: false };
    const o = { symmetry: "p4", palette: "ink", reactivity: 2, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, height: 1440, reduceMotion: false, reduceFlashing: false, relief: 1 };
    let checked = 0;
    let lifted = 0;
    for (let f = 0; f < 3000; f++) {
      audio.beatPhase = (f / 30) % 1;
      audio.onset = f % 15 === 7 || f % 30 === 0;
      audio.onsetStrength = f % 30 === 0 ? 0.95 : f % 7 === 0 ? 0.6 : 0.4;
      for (let i = 0; i < 64; i++) audio.bands[i] = 0.3 + 0.3 * Math.sin(f * 0.05 + i * 0.3) ** 2;
      s.step(audio, 1 / 60, o);
      if (f % 7) continue;
      for (let w = 0; w < 25; w++) {
        const lo = ((w * 0.618 + f * 0.01) % 1) * 0.9;
        const hi = Math.min(1, lo + 0.02 + (w % 5) * 0.03);
        const up = localCeiling(s.lift, s.pops, s.invert, s.relief, s.flipHop, lo, hi);
        expect(up).toBeLessThanOrEqual(s.reliefMax + 1e-6); // never looser than the global bound
        for (let r = 0; r <= 10; r++) {
          const ring = lo + ((hi - lo) * r) / 10;
          let pop = 0;
          for (let k = 0; k < 3; k++) if (s.pops[k * 4] > 0 && Math.abs(ring - s.pops[k * 4 + 1]) < POP_BAND) pop += s.pops[k * 4];
          const fade = tileFade(s.invert[0], s.invert[1], ring);
          const theta = Math.PI * fade;
          const L = liftAt(s.lift, ring);
          for (const vary of [1 - LIFT_VARY, 1 + LIFT_VARY]) {
            for (const x of [-CARD_HALF, 0, CARD_HALF]) {
              const h = Math.min(s.reliefMax, reliefHeight(s.relief, { prof: 1, lift: L * vary, pop, theta, x, hop: s.flipHop }));
              expect(h).toBeLessThanOrEqual(up + 1e-9);
              checked++;
              if (h > 0.1) lifted++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(lifted).toBeGreaterThan(100);
  });

  it("is much lower than the global bound away from the beat's front (that is the point)", () => {
    const lift = new Float32Array(LIFT_BINS);
    for (let b = 0; b < LIFT_BINS; b++) lift[b] = b > 20 && b < 24 ? 0.3 : 0.01;
    const pops = new Float32Array(12);
    const invert = new Float32Array([-1, 0.35, 0]);
    const up = localCeiling(lift, pops, invert, 1, 0.08, 0.1, 0.2);
    expect(up).toBeCloseTo(RELIEF_BLOCK + 0.01 * (1 + LIFT_VARY), 6); // (float32 bins)
    expect(localCeiling(lift, pops, invert, 1, 0.08, 0.6, 0.75)).toBeCloseTo(RELIEF_BLOCK + 0.3 * (1 + LIFT_VARY), 6);
    invert[0] = 0.15; // a card turning at ring 0.15
    expect(localCeiling(lift, pops, invert, 1, 0.08, 0.1, 0.2)).toBeCloseTo(up + CARD_RISE * (2 * CARD_HALF + 0.08), 6);
  });

  it("takes the ring range of a window round the ring (folded at the camera and opposite it)", () => {
    const out = [0, 0];
    expect(ringRange(0.3, 0.3, 0.05, out)).toEqual([0, 0.1]);
    ringRange(0.5, 0.25, 0.05, out);
    expect(out[0]).toBeCloseTo(0.4, 12);
    expect(out[1]).toBeCloseTo(0.6, 12);
    ringRange(0.79, 0.3, 0.05, out); // half a turn away: ring 1
    expect(out[0]).toBeCloseTo(0.88, 12);
    expect(out[1]).toBe(1);
  });

  it("covers every point a step can reach, and the tile centre the engine rings it by", () => {
    // A tile's ring is its centre's, in the warped tile plane: within RING_REACH (plane units)
    // of the point round the ring, for the engine's warps.
    const t = createTile();
    const cen = [0, 0];
    const d = [0, 0];
    for (const g of ["p4", "p3"]) {
      const grp = groupOf(g);
      for (const seed of [0, 3, 6]) {
        const s = morphedState(g, seed);
        const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
        let reach = 0;
        for (let i = 0; i < 4000; i++) {
          const x = 4 + ((i * 0.618) % 1) * 6;
          const y = 2 + ((i * 0.414) % 1) * 6;
          let qx = x;
          let qy = y;
          for (let k = 0; k < 4; k++) {
            fieldAt(grp, s.ab, blend, qx, qy, d);
            qx += d[0];
            qy += d[1];
          }
          tileAt(grp, qx, qy, t);
          tileCentre(grp, t, cen);
          reach = Math.max(reach, Math.abs(cen[0] - x));
        }
        expect(reach).toBeLessThanOrEqual(RING_REACH / 1.2);
      }
    }
    // A step of STEP_REACH (world) on the shell moves a = θ/2π by at most the window less the
    // tile reach.
    for (const k of [THICKNESS.min, 0.36, THICKNESS.max]) {
      const c = { nu: 0, nv: 0, lx: 0, ly: 0 };
      latticeCounts("p4", k, c);
      const D = 0.45 * k + RELIEF_CAP * k;
      const win = ringWindow(k, D, c.lx);
      for (let i = 0; i < 500; i++) {
        const q = k - D + ((i * 0.37) % 1) * 2 * D;
        const th = ((i * 0.618) % 1) * 2 * Math.PI;
        const ph = ((i * 0.414) % 1) * 2 * Math.PI;
        const X = [(1 + q * Math.cos(ph)) * Math.cos(th), q * Math.sin(ph), (1 + q * Math.cos(ph)) * Math.sin(th)];
        const dir = [Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7 + 1)];
        const n = Math.hypot(...dir);
        const Y = X.map((v, j) => v + (STEP_REACH * dir[j]) / n);
        let da = Math.abs(Math.atan2(Y[2], Y[0]) - th) / (2 * Math.PI);
        da = Math.min(da, 1 - da);
        expect(da).toBeLessThanOrEqual(win - RING_REACH / c.lx + 1e-12);
      }
    }
  });
});
