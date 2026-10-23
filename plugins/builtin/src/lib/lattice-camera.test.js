// @ts-check
import { describe, expect, it } from "vitest";
import { createBeat } from "./lattice-beat.js";
import { LOOK_PITCH, LOOK_RATE, createCamera } from "./lattice-camera.js";
import { flySpeed } from "./lattice.js";

const HZ = 240;

describe("createCamera path", () => {
  it("flies at the requested speed (cells per second, along the path)", () => {
    const cam = createCamera(7);
    let dist = 0;
    let [x, y, z] = cam.pos;
    for (let f = 0; f < HZ * 20; f++) {
      cam.update(1 / HZ, 1.5);
      dist += Math.hypot(cam.pos[0] - x, cam.pos[1] - y, cam.pos[2] - z);
      [x, y, z] = cam.pos;
    }
    expect(dist).toBeGreaterThan(1.5 * 20 * 0.98);
    expect(dist).toBeLessThan(1.5 * 20 * 1.02);
  });

  it("stays in the free channels, far from every rod and cube, while turning onto all three axes", () => {
    for (const seed of [1, 7, 42]) {
      const cam = createCamera(seed);
      let rod = Infinity;
      let node = Infinity;
      const travelled = [0, 0, 0];
      let [x, y, z] = cam.pos;
      for (let f = 0; f < HZ * 120; f++) {
        cam.update(1 / HZ, 2);
        const [px, py, pz] = cam.pos;
        const fx = px - Math.round(px);
        const fy = py - Math.round(py);
        const fz = pz - Math.round(pz);
        // Rods along x lie on lines with integer y and z, and so on.
        rod = Math.min(rod, Math.hypot(fy, fz), Math.hypot(fx, fz), Math.hypot(fx, fy));
        node = Math.min(node, Math.hypot(fx, fy, fz));
        travelled[0] += Math.abs(px - x);
        travelled[1] += Math.abs(py - y);
        travelled[2] += Math.abs(pz - z);
        [x, y, z] = cam.pos;
      }
      expect(rod).toBeGreaterThan(0.45);
      expect(node).toBeGreaterThan(0.6);
      for (const d of travelled) expect(d).toBeGreaterThan(20);
    }
  });

  it("turns the view smoothly: an orthonormal basis whose turn rate is gentle and never jumps", () => {
    const cam = createCamera(3);
    const prev = new Float64Array(3);
    let lastRate = -1;
    let maxRate = 0;
    let maxJump = 0;
    let maxUpStep = 0;
    const prevUp = new Float64Array(3);
    cam.update(0, 1);
    prev.set(cam.fwd);
    prevUp.set(cam.up);
    for (let f = 0; f < HZ * 90; f++) {
      cam.update(1 / HZ, 1);
      const { fwd, up, right } = cam;
      const dot = (/** @type {ArrayLike<number>} */ a, /** @type {ArrayLike<number>} */ b) =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(Math.abs(dot(fwd, fwd) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(dot(up, up) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(dot(fwd, up))).toBeLessThan(1e-9);
      expect(Math.abs(dot(fwd, right))).toBeLessThan(1e-9);
      expect(Math.abs(dot(up, right))).toBeLessThan(1e-9);
      const rate = Math.acos(Math.min(1, dot(prev, fwd))) * HZ; // rad/s
      if (lastRate >= 0) maxJump = Math.max(maxJump, Math.abs(rate - lastRate));
      maxRate = Math.max(maxRate, rate);
      maxUpStep = Math.max(maxUpStep, Math.acos(Math.min(1, dot(prevUp, up))) * HZ);
      lastRate = rate;
      prev.set(fwd);
      prevUp.set(up);
    }
    // At 1 cell/s a 90° turn takes over a second, and the turn rate changes only gradually.
    expect(maxRate).toBeLessThan(1.6);
    expect(maxRate).toBeGreaterThan(0.3); // it does turn
    expect(maxJump).toBeLessThan(0.05);
    expect(maxUpStep).toBeLessThan(1.6);
  });
});

describe("createCamera ahead", () => {
  it("finds the point the camera will reach after flying d more cells", () => {
    const a = createCamera(11);
    const out = new Float64Array(3);
    for (let k = 0; k < 40; k++) {
      a.update(0.37, 1);
      a.ahead(2, out);
      // Fly a copy two cells on in small steps and compare.
      const c = createCamera(11);
      c.update(0.37 * (k + 1), 1);
      c.update(2, 1);
      expect(Math.hypot(out[0] - c.pos[0], out[1] - c.pos[1], out[2] - c.pos[2])).toBeLessThan(0.02);
    }
  });
});

describe("createCamera look-around", () => {
  /** @param {"down" | "move" | "up"} kind @param {number} x @param {number} y */
  const ev = (kind, x, y) => ({ kind, x, y, dx: 0, dy: 0 });
  /** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it("drags the view about the path's heading (the scene follows the pointer) and holds it", () => {
    const cam = createCamera(5);
    cam.update(1 / HZ, 1);
    cam.pointer(ev("down", 100, 100));
    cam.pointer(ev("move", 200, 100));
    cam.update(1 / HZ, 1);
    const yaw = 100 * LOOK_RATE;
    // Dragging right turns the view left, about the camera's up.
    expect(dot(cam.view.fwd, cam.fwd)).toBeCloseTo(Math.cos(yaw), 6);
    expect(dot(cam.view.fwd, cam.right)).toBeCloseTo(-Math.sin(yaw), 6);
    expect(dot(cam.view.up, cam.up)).toBeCloseTo(1, 6);
    // Held still: no easing back while the pointer is down.
    for (let f = 0; f < HZ; f++) cam.update(1 / HZ, 1);
    expect(cam.lookYaw).toBeCloseTo(-yaw, 9);
    // Dragging down looks up, within LOOK_PITCH.
    cam.pointer(ev("move", 200, 130));
    cam.update(1 / HZ, 1);
    expect(dot(cam.view.fwd, cam.up)).toBeCloseTo(Math.sin(30 * LOOK_RATE), 6);
    cam.pointer(ev("move", 200, 100000));
    expect(cam.lookPitch).toBe(LOOK_PITCH);
    // The view basis stays orthonormal.
    cam.update(1 / HZ, 1);
    const v = cam.view;
    expect(dot(v.fwd, v.fwd)).toBeCloseTo(1, 9);
    expect(dot(v.fwd, v.up)).toBeCloseTo(0, 9);
    expect(dot(v.fwd, v.right)).toBeCloseTo(0, 9);
    expect(dot(v.up, v.right)).toBeCloseTo(0, 9);
  });

  it("eases back to the heading after release: from rest, without overshoot, within a few seconds", () => {
    const cam = createCamera(5);
    cam.pointer(ev("down", 0, 0));
    cam.pointer(ev("move", 150, -100));
    cam.update(1 / HZ, 1);
    const yaw0 = cam.lookYaw;
    const pitch0 = cam.lookPitch;
    cam.pointer(ev("up", 150, -100));
    let prevYaw = yaw0;
    let firstStep = NaN;
    for (let f = 0; f < HZ * 3; f++) {
      cam.update(1 / HZ, 1);
      if (Number.isNaN(firstStep)) firstStep = Math.abs(cam.lookYaw - yaw0);
      expect(Math.sign(cam.lookYaw)).not.toBe(-Math.sign(yaw0)); // never crosses over
      expect(Math.abs(cam.lookYaw)).toBeLessThanOrEqual(Math.abs(prevYaw) + 1e-12);
      prevYaw = cam.lookYaw;
    }
    // Starts from rest: the first step is tiny next to the offset.
    expect(firstStep).toBeLessThan(Math.abs(yaw0) * 0.001);
    expect(Math.abs(cam.lookYaw)).toBeLessThan(Math.abs(yaw0) * 0.03);
    expect(Math.abs(cam.lookPitch)).toBeLessThan(Math.abs(pitch0) * 0.03);
  });
});

/**
 * Fly 60 s through the entry's chain at 120 BPM — beat envelope → flySpeed (Speed 1,
 * Reactivity `react`) → update, with a beat call on every beat. With `uneven`, every 37 frames
 * one 50 ms frame stands in for three and, 37 frames on, one 33 ms frame for two, so its clock
 * meets the 60 Hz clock again after each hitch. Records the worst acceleration (along the path
 * and across it), jerk, angular velocity and angular acceleration of the view direction, and
 * the position and view direction at every 60 Hz tick both clocks share.
 * @param {{ uneven?: boolean, react?: number, bpm?: number }} o
 */
function beatRun(o) {
  const cam = createCamera(0x1a77);
  const beat = createBeat();
  const bpm = o.bpm ?? 120;
  const a = { bpm, beatPhase: 0, onset: false, onsetStrength: 0 };
  let tick = 0; // 60 Hz ticks elapsed
  let frame = 0;
  /** @type {number[] | null} */ let pv = null;
  /** @type {number[] | null} */ let ac0 = null;
  /** @type {number[]} */ let p0 = Array.from(cam.pos);
  /** @type {number[]} */ let f0 = Array.from(cam.view.fwd);
  let w0 = -1;
  let dt0 = 1 / 60;
  const worst = { along: 0, across: 0, jerk: 0, w: 0, wacc: 0 };
  /** @type {Map<number, number[]>} */
  const at = new Map();
  while (tick < 3600) {
    const n = o.uneven && frame % 37 === 13 ? (frame % 74 === 13 ? 3 : 2) : 1;
    const dt = n / 60;
    tick += n;
    frame++;
    const t = tick / 60;
    a.beatPhase = bpm > 0 ? ((t * bpm) / 60) % 1 : 0;
    beat.step(a, dt);
    if (beat.beat) cam.beat();
    cam.update(dt, flySpeed(1, beat.env, o.react ?? 1, false));
    const p = Array.from(cam.pos);
    const f = Array.from(cam.view.fwd);
    at.set(tick, [...p, ...f]);
    const v = p.map((x, i) => (x - p0[i]) / dt);
    const speed = Math.hypot(...v);
    if (pv) {
      const ac = v.map((x, i) => (x - /** @type {number[]} */ (pv)[i]) / ((dt + dt0) / 2));
      const along = (ac[0] * v[0] + ac[1] * v[1] + ac[2] * v[2]) / speed;
      worst.along = Math.max(worst.along, Math.abs(along));
      worst.across = Math.max(worst.across, Math.hypot(...ac.map((x, i) => x - (along * v[i]) / speed)));
      if (ac0) worst.jerk = Math.max(worst.jerk, Math.hypot(...ac.map((x, i) => (x - /** @type {number[]} */ (ac0)[i]) / dt)));
      ac0 = ac;
    }
    pv = v;
    const w = Math.acos(Math.min(1, f[0] * f0[0] + f[1] * f0[1] + f[2] * f0[2])) / dt;
    worst.w = Math.max(worst.w, w);
    if (w0 >= 0) worst.wacc = Math.max(worst.wacc, Math.abs(w - w0) / dt);
    w0 = w;
    p0 = p;
    f0 = f;
    dt0 = dt;
  }
  return { worst, cam, at };
}

describe("createCamera smoothness over a beat run", () => {
  it("surges smoothly: small acceleration along the path, small jerk and angular acceleration", () => {
    const { worst } = beatRun({});
    // Before: 10 cells/s² of acceleration just after each beat (the surge's 80 ms smoothstep,
    // taken whole), jerk 327 cells/s³, angular velocity 1.97 rad/s, angular acceleration 13 rad/s².
    expect(worst.along).toBeLessThan(1);
    // Across the path it's the corners' centripetal acceleration (curvature ≈ 2.9 at ~1.2
    // cells/s): the channel's floor, not a lurch.
    expect(worst.across).toBeLessThan(5);
    expect(worst.jerk).toBeLessThan(25);
    expect(worst.w).toBeLessThan(1.6);
    expect(worst.wacc).toBeLessThan(4);
  });

  it("is frame-rate independent: hitches in dt don't move it off the 60 Hz flight", () => {
    /** Worst position and view-direction gap at the ticks both runs share. */
    const gap = (/** @type {Map<number, number[]>} */ even, /** @type {Map<number, number[]>} */ hitchy) => {
      let dp = 0;
      let df = 0;
      let shared = 0;
      for (const [tick, q] of hitchy) {
        const r = even.get(tick);
        if (!r) continue;
        shared++;
        dp = Math.max(dp, Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]));
        df = Math.max(df, Math.acos(Math.min(1, q[3] * r[3] + q[4] * r[4] + q[5] * r[5])));
      }
      expect(shared).toBeGreaterThan(3000);
      return { dp, df };
    };
    // Steady input: the substepped integration lands on the same flight.
    const steady = gap(beatRun({ bpm: 0, react: 0 }).at, beatRun({ bpm: 0, react: 0, uneven: true }).at);
    expect(steady.dp).toBeLessThan(1e-3);
    expect(steady.df).toBeLessThan(1e-3);
    // With beats, a hitch holds one target speed for its whole frame and can delay a beat by up to
    // two frames; that's all that differs.
    const beats = gap(beatRun({}).at, beatRun({ uneven: true }).at);
    expect(beats.dp).toBeLessThan(0.02);
    expect(beats.df).toBeLessThan(0.03);
  });

  it("decides turns on beats; in silence it still turns now and then", () => {
    const beats = beatRun({}).cam;
    expect(beats.beatTurns).toBeGreaterThanOrEqual(8);
    expect(beats.idleTurns).toBe(0);
    const silent = beatRun({ bpm: 0, react: 0 }).cam;
    expect(silent.beatTurns).toBe(0);
    expect(silent.idleTurns).toBeGreaterThanOrEqual(3);
  });
});
