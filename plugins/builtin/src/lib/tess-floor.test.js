// @ts-check
import { describe, expect, it } from "vitest";
import {
  basePitch,
  cameraHeight,
  createFloorCamera,
  DRAG_PAN,
  DRAG_TILT,
  FLY,
  fogDistance,
  HEIGHT_MAX,
  HEIGHT_MIN,
  PITCH_MAX,
  PITCH_MIN,
} from "./tess-floor.js";
import { BLEND_PERIOD } from "./tess-music.js";
import { groupOf } from "./tess.js";

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
