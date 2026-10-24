// @ts-check
import { describe, expect, it } from "vitest";
import { LOOK_RATE } from "./lattice-camera.js";
import { createBeat } from "./lattice-beat.js";
import { flySpeed } from "./lattice.js";
import { createNetCamera, netEdges } from "./net-camera.js";
import { NEAR_CLEARANCE } from "./structures.js";
import { TPMS, tpmsClearance } from "./tpms.js";

const HZ = 240;
const NAMES = /** @type {const} */ (["gyroid", "schwarz-p", "schwarz-d"]);

describe("netEdges", () => {
  it("finds each labyrinth's skeleton: srs (3 edges), cubic (6), diamond (4), with the edge lengths", () => {
    const want = { gyroid: [3, Math.SQRT2 / 4], "schwarz-p": [6, 1], "schwarz-d": [4, Math.sqrt(3) / 4] };
    for (const name of NAMES) {
      const s = TPMS[name];
      const edges = netEdges(s);
      expect(edges.length).toBe(s.nodes.length);
      for (const list of edges) {
        expect(list.length, name).toBe(want[name][0]);
        for (const e of list) expect(Math.hypot(e[0], e[1], e[2]) / s.period, name).toBeCloseTo(want[name][1], 9);
      }
      // srs: the three edges at a node lie in a plane at 120°; they sum to zero for every net here.
      for (const list of edges) {
        const sum = [0, 1, 2].map((c) => list.reduce((a, e) => a + e[c], 0));
        expect(Math.hypot(...sum), name).toBeLessThan(1e-9);
      }
    }
  });
});

describe("createNetCamera path", () => {
  it("flies at the requested speed (cells per second, along the path)", () => {
    for (const name of NAMES) {
      const cam = createNetCamera(TPMS[name], 7);
      let dist = 0;
      let [x, y, z] = cam.pos;
      for (let f = 0; f < HZ * 20; f++) {
        cam.update(1 / HZ, 1.5);
        dist += Math.hypot(cam.pos[0] - x, cam.pos[1] - y, cam.pos[2] - z);
        [x, y, z] = cam.pos;
      }
      expect(dist, name).toBeGreaterThan(1.5 * 20 * 0.98);
      expect(dist, name).toBeLessThan(1.5 * 20 * 1.02);
    }
  });

  it("stays in its labyrinth, clear of the worst-case walls, while heading along all three axes", () => {
    for (const name of NAMES) {
      const clear = tpmsClearance(TPMS[name]);
      for (const seed of [1, 7, 42]) {
        const cam = createNetCamera(TPMS[name], seed);
        let least = Infinity;
        const net = [0, 0, 0];
        const start = Array.from(cam.pos);
        const reached = [0, 0, 0];
        for (let f = 0; f < HZ * 120; f++) {
          // Beats every half second, so it changes heading.
          if (f % (HZ / 2) === 0) cam.beat();
          cam.update(1 / HZ, 2);
          least = Math.min(least, clear(cam.pos));
          for (let c = 0; c < 3; c++) {
            net[c] = cam.pos[c] - start[c];
            reached[c] = Math.max(reached[c], Math.abs(net[c]));
          }
        }
        expect(least, `${name} seed ${seed}`).toBeGreaterThan(NEAR_CLEARANCE);
        // It gets somewhere along every axis (no dithering in place).
        for (const d of reached) expect(d, `${name} seed ${seed}`).toBeGreaterThan(8);
      }
    }
  });

  it("turns the view smoothly: an orthonormal basis whose turn rate is gentle and never jumps", () => {
    for (const name of NAMES) {
      const cam = createNetCamera(TPMS[name], 3);
      const prev = new Float64Array(3);
      let lastRate = -1;
      let maxRate = 0;
      let maxJump = 0;
      cam.update(0, 1);
      prev.set(cam.fwd);
      const dot = (/** @type {ArrayLike<number>} */ a, /** @type {ArrayLike<number>} */ b) =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      for (let f = 0; f < HZ * 90; f++) {
        if (f % HZ === 0) cam.beat();
        cam.update(1 / HZ, 1);
        const { fwd, up, right } = cam;
        expect(Math.abs(dot(fwd, fwd) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(up, up) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(fwd, up))).toBeLessThan(1e-9);
        expect(Math.abs(dot(fwd, right))).toBeLessThan(1e-9);
        expect(Math.abs(dot(up, right))).toBeLessThan(1e-9);
        const rate = Math.acos(Math.min(1, dot(prev, fwd))) * HZ;
        if (lastRate >= 0) maxJump = Math.max(maxJump, Math.abs(rate - lastRate));
        maxRate = Math.max(maxRate, rate);
        lastRate = rate;
        prev.set(fwd);
      }
      expect(maxRate, name).toBeLessThan(1.6);
      expect(maxRate, name).toBeGreaterThan(0.3);
      expect(maxJump, name).toBeLessThan(0.05);
    }
  });

  it("ahead finds the point the camera will reach after flying d more cells", () => {
    for (const name of NAMES) {
      const a = createNetCamera(TPMS[name], 11);
      const out = new Float64Array(3);
      for (let k = 0; k < 30; k++) {
        a.update(0.37, 1);
        a.ahead(2, out);
        const c = createNetCamera(TPMS[name], 11);
        c.update(0.37 * (k + 1), 1);
        c.update(2, 1);
        expect(Math.hypot(out[0] - c.pos[0], out[1] - c.pos[1], out[2] - c.pos[2]), name).toBeLessThan(0.02);
      }
    }
  });

  it("drags to look around and eases back on release", () => {
    const cam = createNetCamera(TPMS.gyroid, 5);
    const ev = (/** @type {"down" | "move" | "up"} */ kind, /** @type {number} */ x) => ({ kind, x, y: 0, dx: 0, dy: 0 });
    cam.update(1 / HZ, 1);
    cam.pointer(ev("down", 100));
    cam.pointer(ev("move", 200));
    cam.update(1 / HZ, 1);
    expect(cam.lookYaw).toBeCloseTo(-100 * LOOK_RATE, 9);
    cam.pointer(ev("up", 200));
    for (let f = 0; f < HZ * 3; f++) cam.update(1 / HZ, 1);
    expect(Math.abs(cam.lookYaw)).toBeLessThan(100 * LOOK_RATE * 0.03);
  });
});

/**
 * lattice-camera.test.js's beat run (60 s at 120 BPM through the entry's chain; `uneven` adds
 * 50 ms and 33 ms hitches) for a net camera.
 * @param {import('./tpms.js').Surface} s @param {{ uneven?: boolean, react?: number, bpm?: number }} o
 */
function beatRun(s, o) {
  const cam = createNetCamera(s, 0x1a77);
  const beat = createBeat();
  const bpm = o.bpm ?? 120;
  const a = { bpm, beatPhase: 0, onset: false, onsetStrength: 0 };
  let tick = 0;
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

describe("createNetCamera smoothness over a beat run", () => {
  it("surges smoothly: small acceleration along the path, small jerk and angular acceleration", () => {
    for (const name of NAMES) {
      const { worst } = beatRun(TPMS[name], {});
      expect(worst.along, name).toBeLessThan(1);
      expect(worst.across, name).toBeLessThan(5);
      expect(worst.jerk, name).toBeLessThan(25);
      expect(worst.w, name).toBeLessThan(1.6);
      expect(worst.wacc, name).toBeLessThan(4);
    }
  });

  it("is frame-rate independent: hitches in dt don't move it off the 60 Hz flight", () => {
    const gap = (/** @type {Map<number, number[]>} */ even, /** @type {Map<number, number[]>} */ hitchy) => {
      let dp = 0;
      let df = 0;
      for (const [tick, q] of hitchy) {
        const r = even.get(tick);
        if (!r) continue;
        dp = Math.max(dp, Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]));
        df = Math.max(df, Math.acos(Math.min(1, q[3] * r[3] + q[4] * r[4] + q[5] * r[5])));
      }
      return { dp, df };
    };
    for (const name of NAMES) {
      const s = TPMS[name];
      const steady = gap(beatRun(s, { bpm: 0, react: 0 }).at, beatRun(s, { bpm: 0, react: 0, uneven: true }).at);
      expect(steady.dp, name).toBeLessThan(1e-3);
      expect(steady.df, name).toBeLessThan(1e-3);
      const beats = gap(beatRun(s, {}).at, beatRun(s, { uneven: true }).at);
      expect(beats.dp, name).toBeLessThan(0.02);
      expect(beats.df, name).toBeLessThan(0.03);
    }
  });

  it("decides its heading changes on beats, placed ahead of the view; in silence it still turns now and then", () => {
    for (const name of NAMES) {
      const beats = beatRun(TPMS[name], {}).cam;
      expect(beats.beatTurns, name).toBeGreaterThanOrEqual(5);
      expect(beats.idleTurns, name).toBe(0);
      const silent = beatRun(TPMS[name], { bpm: 0, react: 0 }).cam;
      expect(silent.beatTurns, name).toBe(0);
      expect(silent.idleTurns, name).toBeGreaterThanOrEqual(2);
    }
  });

  it("a beat never moves the path the camera is on or looking at", () => {
    for (const name of NAMES) {
      const a = createNetCamera(TPMS[name], 9);
      const b = createNetCamera(TPMS[name], 9);
      for (let f = 0; f < HZ * 10; f++) {
        a.update(1 / HZ, 1);
        b.update(1 / HZ, 1);
      }
      const pa = new Float64Array(3);
      const pb = new Float64Array(3);
      b.beat();
      // Whatever the beat decides, the next 3 cells of the path are the same.
      for (const d of [0, 1, 2, 3]) {
        a.ahead(d, pa);
        b.ahead(d, pb);
        expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), name).toBeLessThan(1e-12);
      }
    }
  });
});
