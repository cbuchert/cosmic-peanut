// @ts-check
import { describe, expect, it } from "vitest";
import {
  basePitch,
  cameraHeight,
  createFloorCamera,
  DRAG_PAN,
  DRAG_TILT,
  FADE_FAR,
  FADE_NEAR,
  FLY,
  floorLight,
  fogDistance,
  HEIGHT_MAX,
  HEIGHT_MIN,
  heightFrame,
  MARCH_MAX,
  marchSteps,
  marchTop,
  PITCH_MAX,
  PITCH_MIN,
  reliefFade,
  reliefScale,
  STEP_GROUND,
  STEP_TEXELS,
  TOP_FRAC,
} from "./tess-floor.js";
import { HEIGHT_SCALE } from "./tess-gl.js";
import { BEAT_ACCENT, BLEND_PERIOD, HEAVE_GAIN, LIFT_GAIN, LIFT_VARY, LIGHT_ELEVATION, POP_GAIN, RELIEF_DEFAULT } from "./tess-music.js";
import { groupOf, reliefBound } from "./tess.js";

const DT = 1 / 60;
const P4 = groupOf("p4").basis;
const P3 = groupOf("p3").basis;

/** @param {Partial<import('./tess-floor.js').FloorInput>} o */
const input = (o = {}) => ({ travel: 0, height: 0.6, pitch: 0.3, reduceMotion: false, basis: P4, ...o });

/** Pointer event in CSS px. @param {"down"|"move"|"up"} kind */
const ptr = (kind, x = 0, y = 0) => ({ kind, x, y, dx: 0, dy: 0 });

describe("param mapping", () => {
  it("maps Height 0–1 onto the camera height range, monotonically", () => {
    expect(cameraHeight(0)).toBeCloseTo(HEIGHT_MIN);
    expect(cameraHeight(1)).toBeCloseTo(HEIGHT_MAX);
    expect(cameraHeight(0.5)).toBeGreaterThan(cameraHeight(0.25));
    expect(cameraHeight(2)).toBeCloseTo(HEIGHT_MAX);
    expect(cameraHeight(Number.NaN)).toBeCloseTo(cameraHeight(0.5));
  });

  it("maps Tilt 0–1 onto how far the view looks down, keeping the horizon in view", () => {
    expect(basePitch(0)).toBeCloseTo(PITCH_MIN);
    expect(basePitch(1)).toBeCloseTo(PITCH_MAX);
    expect(basePitch(0.7)).toBeGreaterThan(basePitch(0.3));
    expect(basePitch(-1)).toBeCloseTo(PITCH_MIN);
    expect(basePitch("x")).toBeCloseTo(basePitch(0.5));
    expect(PITCH_MIN).toBeGreaterThan(0);
  });

  it("brings the fog in as Fog rises, in multiples of the camera height", () => {
    expect(fogDistance(1, 1)).toBeLessThan(fogDistance(0, 1));
    expect(fogDistance(0.5, 2)).toBeCloseTo(2 * fogDistance(0.5, 1));
    expect(fogDistance(0.5, 1)).toBeGreaterThan(0);
    expect(fogDistance(Number.NaN, 1)).toBeCloseTo(fogDistance(0.5, 1));
  });
});

describe("camera path", () => {
  it("glides along its heading by the state's travel, faster when higher", () => {
    const run = (/** @type {number} */ height) => {
      const c = createFloorCamera();
      c.step(DT, input({ travel: 0, height }));
      const x = c.x;
      const y = c.y;
      const h = c.heading;
      c.step(DT, input({ travel: 0.5, height }));
      return { d: Math.hypot(c.x - x, c.y - y), dx: c.x - x, dy: c.y - y, h };
    };
    const low = run(0.5);
    expect(low.d).toBeGreaterThan(0.05);
    expect(low.d).toBeCloseTo(FLY * 0.5 * 0.5, 5);
    expect(Math.atan2(low.dy, low.dx)).toBeCloseTo(low.h, 2);
    expect(run(1).d).toBeCloseTo(2 * low.d, 5);
  });

  it("doesn't move without travel", () => {
    const c = createFloorCamera();
    c.step(DT, input({ travel: 3 }));
    const x = c.x;
    const y = c.y;
    for (let i = 0; i < 60; i++) c.step(DT, input({ travel: 3 }));
    expect(c.x).toBeCloseTo(x, 9);
    expect(c.y).toBeCloseTo(y, 9);
  });

  it("drifts its heading slowly and smoothly, slower with Reduce motion", () => {
    const turn = (/** @type {boolean} */ reduceMotion) => {
      const c = createFloorCamera();
      let prev = Number.NaN;
      let prevD = Number.NaN;
      let maxD = 0;
      let maxDD = 0;
      let total = 0;
      for (let i = 0; i < 60 * 60; i++) {
        c.step(DT, input({ reduceMotion }));
        if (!Number.isNaN(prev)) {
          const d = c.heading - prev;
          total += Math.abs(d);
          maxD = Math.max(maxD, Math.abs(d) / DT);
          if (!Number.isNaN(prevD)) maxDD = Math.max(maxDD, Math.abs(d - prevD) / (DT * DT));
          prevD = d;
        }
        prev = c.heading;
      }
      return { maxD, maxDD, total };
    };
    const full = turn(false);
    expect(full.total).toBeGreaterThan(0.2); // it does turn over a minute
    expect(full.maxD).toBeLessThan(0.1); // rad/s: slow
    expect(full.maxDD).toBeLessThan(0.05); // rad/s²: no kinks
    expect(turn(true).maxD).toBeLessThan(0.3 * full.maxD);
  });

  it("wraps its position every BLEND_PERIOD lattice steps (the tiling repeats there)", () => {
    for (const basis of [P4, P3]) {
      const c = createFloorCamera();
      for (let i = 0; i <= 600; i++) c.step(DT, input({ travel: i * 0.5, height: 1, basis }));
      expect(Math.hypot(c.x, c.y)).toBeGreaterThan(0);
      const det = basis[0][0] * basis[1][1] - basis[1][0] * basis[0][1];
      const la = (c.x * basis[1][1] - c.y * basis[1][0]) / det;
      const lb = (c.y * basis[0][0] - c.x * basis[0][1]) / det;
      for (const l of [la, lb]) {
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThan(BLEND_PERIOD);
      }
    }
  });

  it("looks along the heading, tilted down by the pitch, with an orthonormal basis", () => {
    const c = createFloorCamera();
    c.step(DT, input({ pitch: 0.4 }));
    const [fx, fy, fz] = c.fwd;
    expect(fz).toBeCloseTo(-Math.sin(0.4), 5);
    expect(Math.atan2(fy, fx)).toBeCloseTo(c.yaw, 5);
    expect(c.yaw).toBeCloseTo(c.heading, 9);
    const dot = (/** @type {Float32Array} */ a, /** @type {Float32Array} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const v of [c.fwd, c.right, c.up]) expect(dot(v, v)).toBeCloseTo(1, 5);
    expect(dot(c.fwd, c.right)).toBeCloseTo(0, 5);
    expect(dot(c.fwd, c.up)).toBeCloseTo(0, 5);
    expect(dot(c.right, c.up)).toBeCloseTo(0, 5);
    expect(c.right[2]).toBeCloseTo(0, 5); // the horizon stays level
    expect(c.up[2]).toBeGreaterThan(0);
    expect(c.h).toBeCloseTo(0.6);
  });
});

describe("drag", () => {
  it("pans and tilts the view while dragging", () => {
    const c = createFloorCamera();
    c.step(DT, input());
    c.pointer(ptr("down", 100, 100));
    c.pointer(ptr("move", 150, 120));
    c.step(DT, input());
    expect(c.dragging).toBe(true);
    expect(c.pan).toBeCloseTo(50 * DRAG_PAN, 5); // grab the world: drag right, turn left
    expect(c.yaw).toBeCloseTo(c.heading + c.pan, 5);
    expect(c.pitch).toBeCloseTo(0.3 - 20 * DRAG_TILT, 5); // drag down, look up
  });

  it("keeps the tilt between looking at the horizon and looking nearly straight down", () => {
    const c = createFloorCamera();
    c.pointer(ptr("down", 0, 0));
    c.pointer(ptr("move", 0, 5000));
    c.step(DT, input());
    expect(c.pitch).toBeGreaterThan(0);
    c.pointer(ptr("move", 0, -5000));
    c.step(DT, input());
    expect(c.pitch).toBeLessThan(Math.PI / 2);
  });

  it("eases back after release: starts at rest, never overshoots, settles in a few seconds", () => {
    const c = createFloorCamera();
    c.step(DT, input());
    c.pointer(ptr("down", 0, 0));
    c.pointer(ptr("move", 200, 60));
    c.step(DT, input());
    c.pointer(ptr("up", 200, 60));
    const pan0 = c.pan;
    const tilt0 = c.tilt;
    expect(pan0).toBeGreaterThan(0);
    c.step(DT, input());
    expect(Math.abs(pan0 - c.pan)).toBeLessThan(0.01 * pan0); // no snap on release
    let prev = c.pan;
    for (let i = 0; i < 60 * 4; i++) {
      c.step(DT, input());
      expect(c.pan).toBeLessThanOrEqual(prev + 1e-12);
      expect(c.pan).toBeGreaterThanOrEqual(-1e-9);
      prev = c.pan;
    }
    expect(Math.abs(c.pan)).toBeLessThan(0.02 * pan0);
    expect(Math.abs(c.tilt)).toBeLessThan(0.02 * Math.abs(tilt0));
    expect(c.pitch).toBeCloseTo(0.3, 2);
  });

  it("eases back more slowly with Reduce motion", () => {
    const back = (/** @type {boolean} */ reduceMotion) => {
      const c = createFloorCamera();
      c.pointer(ptr("down", 0, 0));
      c.pointer(ptr("move", 200, 0));
      c.step(DT, input({ reduceMotion }));
      c.pointer(ptr("up", 200, 0));
      for (let i = 0; i < 60; i++) c.step(DT, input({ reduceMotion }));
      return c.pan;
    };
    expect(back(true)).toBeGreaterThan(back(false));
  });
});

// ---- Relief on the floor: the height-field march's bounds and steps ----------------------------

/** The camera of tile-horizon.frag in its own frame: ray direction for screen point (sx, sy). */
const FOCAL = 1.6;
/**
 * Where the ray through screen point (sx, sy) (half-short-side units) is at height z, and that
 * point's footprint on the ground (z = 0) back on the screen. Plain 3D, independent of the module.
 * @param {number} sx @param {number} sy @param {number} z @param {number} h camera height @param {number} pitch
 */
function footprint(sx, sy, z, h, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Camera frame: x right, y up, z forward; world z up. fwd = (0, cp, -sp), up = (0, sp, cp).
  const d = [sx, FOCAL * cp + sy * sp, -FOCAL * sp + sy * cp];
  const down = -d[2];
  if (down <= 0) return null;
  const t = (h - z) / down;
  const P = [t * d[0], t * d[1], h - t * down]; // relative to the camera's ground point
  const v = [P[0], P[1], -h]; // ground point under P, from the camera
  const cz = v[1] * cp - v[2] * sp;
  const cy = v[1] * sp + v[2] * cp;
  return { dist: Math.hypot(P[0], P[1]), x: (FOCAL * v[0]) / cz, y: (FOCAL * cy) / cz, ground: [P[0], P[1]] };
}

/** Defaults: Height 0.4, Tilt 0.5, Relief 0.6 at Reactivity 1, every lift and pop at its peak, no card turning. */
const H0 = cameraHeight(0.4);
const P0 = basePitch(0.5);
const liftPeak = (LIFT_GAIN + HEAVE_GAIN) * (1 + LIFT_VARY);
const BOUND0 = reliefBound(RELIEF_DEFAULT, liftPeak, POP_GAIN, false, 0);

describe("relief scale and bound", () => {
  it("keeps the relief full size down to the default camera height, then shrinks it with the camera", () => {
    expect(reliefScale(H0)).toBe(1);
    expect(reliefScale(HEIGHT_MAX)).toBe(1);
    expect(reliefScale(H0 / 2)).toBeCloseTo(0.5, 9);
    expect(reliefScale(HEIGHT_MIN)).toBeCloseTo(HEIGHT_MIN / H0, 9);
  });

  it("starts the march at the scaled bound, never within reach of the camera", () => {
    expect(marchTop(BOUND0, H0)).toBeCloseTo(BOUND0, 12);
    expect(marchTop(0.1, HEIGHT_MIN)).toBeCloseTo(0.1 * reliefScale(HEIGHT_MIN), 12);
    for (const h of [HEIGHT_MIN, H0, HEIGHT_MAX]) {
      for (const b of [0, 0.05, 0.3, 1, 5]) {
        expect(marchTop(b, h)).toBeLessThanOrEqual(TOP_FRAC * h + 1e-12);
        expect(marchTop(b, h)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(TOP_FRAC).toBeLessThan(1);
  });

  it("fades the relief out with distance in camera heights, eased at both ends", () => {
    for (const h of [HEIGHT_MIN, H0, HEIGHT_MAX]) {
      expect(reliefFade(0, h)).toBe(1);
      expect(reliefFade(FADE_NEAR * h, h)).toBe(1);
      expect(reliefFade(FADE_FAR * h, h)).toBe(0);
      expect(reliefFade(100 * h, h)).toBe(0);
      expect(reliefFade(0.5 * (FADE_NEAR + FADE_FAR) * h, h)).toBeCloseTo(0.5, 9);
      let last = 1;
      for (let r = 0; r <= FADE_FAR * h; r += h / 50) {
        const k = reliefFade(r, h);
        expect(k).toBeLessThanOrEqual(last + 1e-12);
        last = k;
      }
      const e = 1e-4 * h; // flat ends: no kink where the fade starts or stops
      expect(1 - reliefFade(FADE_NEAR * h + e, h)).toBeLessThan(1e-6);
      expect(reliefFade(FADE_FAR * h - e, h)).toBeLessThan(1e-6);
    }
    // Well before the horizon at the default Fog (fogDistance in camera heights).
    expect(FADE_FAR).toBeLessThan(fogDistance(0.5, 1) / 2);
  });
});

describe("height map frame", () => {
  /** @type {{ h: number, pitch: number, top: number }[]} */
  const cases = [];
  for (const h of [HEIGHT_MIN, H0, HEIGHT_MAX])
    for (const pitch of [0.03, PITCH_MIN, P0, PITCH_MAX, 1.0, 1.3]) for (const f of [0, 0.3, 1]) cases.push({ h, pitch, top: f * TOP_FRAC * h });

  it("holds the ground footprint of every point a ray can meet the relief at (|x| no wider than the screen)", () => {
    const out = new Float64Array(2);
    const aspect = 16 / 9;
    for (const { h, pitch, top } of cases) {
      heightFrame(h, pitch, FOCAL, top, out);
      const [lo, hi] = out;
      expect(hi).toBeGreaterThan(lo);
      expect(hi).toBeLessThanOrEqual(1);
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; j <= 8; j++) {
          const sy = -1 + i / 20;
          const sx = aspect * (-1 + j / 4);
          for (let k = 0; k <= 10; k++) {
            const f = footprint(sx, sy, (top * k) / 10, h, pitch);
            if (!f || f.dist > FADE_FAR * h) continue; // past the relief: heights are 0, the map isn't read
            expect(f.y).toBeGreaterThanOrEqual(lo - 1e-9);
            expect(f.y).toBeLessThanOrEqual(hi + 1e-9);
            expect(Math.abs(f.x)).toBeLessThanOrEqual(Math.abs(sx) + 1e-9);
          }
        }
      }
    }
  });

  it("is no larger than it needs to be (map texels go where the relief is)", () => {
    const out = new Float64Array(2);
    for (const { h, pitch, top } of cases) {
      heightFrame(h, pitch, FOCAL, top, out);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= 2000; i++) {
        const sy = -1 + i / 1000;
        for (const z of [0, top]) {
          const f = footprint(0, sy, z, h, pitch);
          if (!f || f.dist > FADE_FAR * h) continue;
          lo = Math.min(lo, f.y);
          hi = Math.max(hi, f.y);
        }
      }
      if (lo === Infinity) continue; // the relief is all off screen
      expect(out[0]).toBeGreaterThan(lo - 0.05);
      expect(out[1]).toBeLessThan(hi + 0.05);
    }
  });
});

describe("march steps", () => {
  it("steps no further than STEP_GROUND on the ground or STEP_TEXELS in the map, at least once", () => {
    expect(marchSteps(0, 0)).toBe(1);
    for (const g of [0, 0.01, 0.1, 0.5, 1]) {
      for (const tx of [0, 1, 5, 20]) {
        const n = marchSteps(g, tx);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(MARCH_MAX);
        if (n < MARCH_MAX) expect(Math.min(g / n / STEP_GROUND, tx / n / STEP_TEXELS)).toBeLessThanOrEqual(1 + 1e-12);
        expect(marchSteps(g * 2, tx * 2)).toBeGreaterThanOrEqual(n);
      }
    }
  });

  it("never runs out of steps over the whole 1440p view at the defaults", () => {
    const out = new Float64Array(2);
    const top = marchTop(BOUND0, H0);
    heightFrame(H0, P0, FOCAL, top, out);
    const [lo, hi] = out;
    // The height map: HEIGHT_SCALE of the 2560×1440 print, over x ±16/9 and y lo … hi.
    const tx = (HEIGHT_SCALE * 1440) / 2; // texels per half-short-side in x
    const ty = (HEIGHT_SCALE * 1440) / (hi - lo);
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      for (let j = 0; j <= 10; j++) {
        const sy = -1 + i / 50;
        const sx = (16 / 9) * (-1 + j / 5);
        const a = footprint(sx, sy, top, H0, P0);
        const b = footprint(sx, sy, 0, H0, P0);
        if (!a || !b || a.dist > FADE_FAR * H0) continue;
        // The march runs from the bound down to the ground or the end of the relief, whichever first.
        const end = b.dist <= FADE_FAR * H0 ? b : footAt(sx, sy, FADE_FAR * H0);
        const ground = Math.hypot(end.ground[0] - a.ground[0], end.ground[1] - a.ground[1]);
        const lean = Math.hypot((end.x - a.x) * tx, (end.y - a.y) * ty);
        worst = Math.max(worst, Math.min(ground / STEP_GROUND, lean / STEP_TEXELS));
      }
    }
    expect(worst).toBeGreaterThan(1);
    expect(Math.ceil(worst)).toBeLessThanOrEqual(MARCH_MAX);
  });
});

/** The footprint of the point where the ray through (sx, sy) is `dist` from the camera's ground point. */
function footAt(/** @type {number} */ sx, /** @type {number} */ sy, /** @type {number} */ dist) {
  const b = footprint(sx, sy, 0, H0, P0);
  const z = H0 * (1 - dist / (b?.dist ?? 1));
  const f = footprint(sx, sy, z, H0, P0);
  if (!f) throw new Error("no footprint");
  return f;
}

describe("light", () => {
  it("rakes from round the view at the engine's elevation, level with the view's heading", () => {
    const out = new Float32Array(3);
    const yaw = 0.7;
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    floorLight(90, yaw, out); // from straight ahead (the horizon)
    expect(out[0] * fx + out[1] * fy).toBeCloseTo(Math.cos(LIGHT_ELEVATION), 5);
    expect(out[2]).toBeCloseTo(Math.sin(LIGHT_ELEVATION), 5);
    floorLight(0, yaw, out); // from the right
    expect(out[0] * fy - out[1] * fx).toBeCloseTo(Math.cos(LIGHT_ELEVATION), 5);
    floorLight(135, yaw, out); // default: far left
    expect(out[0] * fx + out[1] * fy).toBeGreaterThan(0);
    expect(out[0] * fy - out[1] * fx).toBeLessThan(0);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 5);
  });
});
