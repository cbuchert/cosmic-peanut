// @ts-check
/**
 * The channel camera (lib/strut-camera.js) over each strut structure's walk: the same smoothness
 * bounds as the cubic camera (lattice-camera.test.js), turns at junctions decided on beats.
 */
import { describe, expect, it } from "vitest";
import { createBeat } from "./lattice-beat.js";
import { flySpeed } from "./lattice.js";
import { bitruncatedCamera } from "./structure-bitruncated.js";
import { diamondCamera } from "./structure-diamond.js";
import { octetCamera } from "./structure-octet.js";

const HZ = 240;
const CAMERAS = { octet: octetCamera, diamond: diamondCamera, bitruncated: bitruncatedCamera };

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 60 s at `bpm` through the entry's chain (beat envelope → flySpeed → update, a beat call on each
 * beat), optionally with hitches (lattice-camera.test.js beatRun): the worst acceleration along and
 * across the path, jerk, angular velocity and acceleration, and the state at each 60 Hz tick.
 * @param {(seed: number) => ReturnType<typeof octetCamera>} make
 * @param {{ uneven?: boolean, react?: number, bpm?: number }} o
 */
function beatRun(make, o) {
  const cam = make(0x1a77);
  const beat = createBeat();
  const bpm = o.bpm ?? 120;
  const a = { bpm, beatPhase: 0, onset: false, onsetStrength: 0 };
  let tick = 0;
  let frame = 0;
  /** @type {number[] | null} */ let pv = null;
  /** @type {number[] | null} */ let ac0 = null;
  let p0 = Array.from(cam.pos);
  let f0 = Array.from(cam.view.fwd);
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
    a.beatPhase = bpm > 0 ? ((tick / 60) * bpm / 60) % 1 : 0;
    beat.step(a, dt);
    if (beat.beat) cam.beat();
    cam.update(dt, flySpeed(1, beat.env, o.react ?? 1, false));
    const p = Array.from(cam.pos);
    const f = Array.from(cam.view.fwd);
    at.set(tick, [...p, ...f]);
    const v = p.map((x, i) => (x - p0[i]) / dt);
    const speed = Math.hypot(...v);
    if (pv) {
      const pvv = pv;
      const ac = v.map((x, i) => (x - pvv[i]) / ((dt + dt0) / 2));
      const along = dot(ac, v) / speed;
      worst.along = Math.max(worst.along, Math.abs(along));
      worst.across = Math.max(worst.across, Math.hypot(...ac.map((x, i) => x - (along * v[i]) / speed)));
      const a0 = ac0;
      if (a0) worst.jerk = Math.max(worst.jerk, Math.hypot(...ac.map((x, i) => (x - a0[i]) / dt)));
      ac0 = ac;
    }
    pv = v;
    const w = Math.acos(Math.min(1, dot(f, f0))) / dt;
    worst.w = Math.max(worst.w, w);
    if (w0 >= 0) worst.wacc = Math.max(worst.wacc, Math.abs(w - w0) / dt);
    w0 = w;
    p0 = p;
    f0 = f;
    dt0 = dt;
  }
  return { worst, cam, at };
}

for (const [name, make] of Object.entries(CAMERAS)) {
  describe(`${name} camera`, () => {
    it("flies at the requested speed along its path, with an orthonormal view", () => {
      const cam = make(7);
      let dist = 0;
      let [x, y, z] = cam.pos;
      for (let f = 0; f < HZ * 20; f++) {
        cam.update(1 / HZ, 1.5);
        dist += Math.hypot(cam.pos[0] - x, cam.pos[1] - y, cam.pos[2] - z);
        [x, y, z] = cam.pos;
        const { fwd, up, right } = cam.view;
        expect(Math.abs(dot(fwd, fwd) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(fwd, up))).toBeLessThan(1e-9);
        expect(Math.abs(dot(up, right))).toBeLessThan(1e-9);
      }
      expect(dist).toBeGreaterThan(1.5 * 20 * 0.98);
      expect(dist).toBeLessThan(1.5 * 20 * 1.02);
    });

    it("surges and turns smoothly over a 120 BPM run (the cubic camera's bounds)", () => {
      const { worst } = beatRun(make, {});
      expect(worst.along).toBeLessThan(1);
      expect(worst.across).toBeLessThan(5);
      expect(worst.jerk).toBeLessThan(25);
      expect(worst.w).toBeLessThan(1.6);
      expect(worst.wacc).toBeLessThan(4);
    });

    it("is frame-rate independent", () => {
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
      const steady = gap(beatRun(make, { bpm: 0, react: 0 }).at, beatRun(make, { bpm: 0, react: 0, uneven: true }).at);
      expect(steady.dp).toBeLessThan(1e-3);
      expect(steady.df).toBeLessThan(1e-3);
      const beats = gap(beatRun(make, {}).at, beatRun(make, { uneven: true }).at);
      expect(beats.dp).toBeLessThan(0.02);
      expect(beats.df).toBeLessThan(0.03);
    });

    it("decides turns on beats; in silence it still turns now and then", () => {
      const beats = beatRun(make, {}).cam;
      expect(beats.beatTurns).toBeGreaterThanOrEqual(8);
      expect(beats.idleTurns).toBe(0);
      const silent = beatRun(make, { bpm: 0, react: 0 }).cam;
      expect(silent.beatTurns).toBe(0);
      expect(silent.idleTurns).toBeGreaterThanOrEqual(3);
    });

    it("finds the point it will reach after flying d more cells", () => {
      const a = make(11);
      const out = new Float64Array(3);
      for (let k = 0; k < 30; k++) {
        a.update(0.37, 1);
        a.ahead(1.6, out);
        const c = make(11);
        c.update(0.37 * (k + 1), 1);
        c.update(1.6, 1);
        expect(Math.hypot(out[0] - c.pos[0], out[1] - c.pos[1], out[2] - c.pos[2])).toBeLessThan(0.02);
      }
    });

    it("drags the view about its heading and eases back on release", () => {
      const cam = make(5);
      cam.update(1 / HZ, 1);
      cam.pointer({ kind: "down", x: 100, y: 100, dx: 0, dy: 0 });
      cam.pointer({ kind: "move", x: 200, y: 100, dx: 0, dy: 0 });
      cam.update(1 / HZ, 1);
      expect(dot(cam.view.fwd, cam.fwd)).toBeLessThan(0.95);
      cam.pointer({ kind: "up", x: 200, y: 100, dx: 0, dy: 0 });
      for (let f = 0; f < HZ * 3; f++) cam.update(1 / HZ, 1);
      expect(Math.abs(cam.lookYaw)).toBeLessThan(0.02);
    });
  });
}
