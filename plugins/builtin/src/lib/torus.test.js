// @ts-check
import { describe, expect, it } from "vitest";
import { createTessState } from "./tess-music.js";
import { createTile, fieldAt, groupOf, tileAt } from "./tess.js";
import { BLEND_PERIOD } from "./tess-music.js";
import { blendPose, conformalAspect, createDrag, createPose, createTorusCamera, DIST, FLOW_U, FLY, mapParams, ORBIT, THICKNESS, TRAVEL, createViewMix, DRAG_RATE, DRAG_RETURN, PITCH_LIMIT, DIVE_TIME, IDLE_TOGGLE, MIN_HOLD, PHRASE_STEPS, VIEWS, viewName, wallFade, insidePose, latticeCounts, minorFraction, minorRate, outsidePose, planePoint } from "./torus.js";

const S3 = Math.sqrt(3);
const THICK = [0.2, 0.28, 0.38, 0.45, 0.5];
const counts = () => ({ nu: 0, nv: 0, lx: 0, ly: 0 });

/** A state with a real warp mid-morph (both sets non-zero, blend drifted). */
function warpedState(/** @type {string} */ symmetry) {
  const s = createTessState();
  const audio = { bands: new Float32Array(16).fill(0.5), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.2, bassAtt: 1.2, silent: false };
  const o = { symmetry, palette: "ink", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, height: 1440, reduceMotion: false, reduceFlashing: false };
  for (let i = 0; i < 600; i++) {
    audio.beatPhase = (i / 30) % 1;
    s.step(audio, 1 / 60, o);
  }
  return s;
}

describe("lattice counts", () => {
  it("are whole multiples of BLEND_PERIOD around both circles, for both groups", () => {
    for (const g of ["p4", "p3"]) {
      for (const k of THICK) {
        const c = latticeCounts(g, k, counts());
        expect(c.nu).toBeGreaterThan(0);
        expect(c.nv).toBeGreaterThan(0);
        expect(c.nu % BLEND_PERIOD).toBe(0);
        expect(c.nv % BLEND_PERIOD).toBe(0);
        expect(c.lx).toBe(c.nu);
        expect(c.ly).toBeCloseTo(g === "p3" ? c.nv * S3 : c.nv, 12);
      }
    }
  });

  it("keep tiles near square: ly / lx within 15 % of the conformal ratio r / √(R² − r²)", () => {
    for (const g of ["p4", "p3"]) {
      for (const k of THICK) {
        const c = latticeCounts(g, k, counts());
        const want = k / Math.sqrt(1 - k * k);
        expect(Math.abs(Math.log(c.ly / c.lx / want))).toBeLessThan(Math.log(1.15));
      }
    }
  });

  it("close the warped tiling exactly: field and tile classes repeat after lx and after ly", () => {
    const d0 = [0, 0];
    const d1 = [0, 0];
    const t0 = createTile();
    const t1 = createTile();
    for (const g of ["p4", "p3"]) {
      const s = warpedState(g);
      const grp = groupOf(g);
      const blend = { kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] };
      for (const k of THICK) {
        const c = latticeCounts(g, k, counts());
        for (let i = 0; i < 40; i++) {
          const x = (0.0131 + i * 0.731) % c.lx; // off the lattice points (tile corners)
          const y = (0.0173 + i * 0.377) % c.ly;
          fieldAt(grp, s.ab, blend, x, y, d0);
          for (const [ox, oy] of [[c.lx, 0], [0, c.ly]]) {
            fieldAt(grp, s.ab, blend, x + ox, y + oy, d1);
            expect(d1[0]).toBeCloseTo(d0[0], 6);
            expect(d1[1]).toBeCloseTo(d0[1], 6);
            const q0 = tileAt(grp, x + d0[0], y + d0[1], t0);
            const q1 = tileAt(grp, x + ox + d1[0], y + oy + d1[1], t1);
            expect(q1.cls).toBe(q0.cls);
            expect(q1.orient).toBe(q0.orient);
          }
        }
      }
    }
  });
});

describe("conformal map of the tube", () => {
  it("runs t from −½ to ½ once around the minor circle, 0 on the outer equator, ½ on the inner", () => {
    for (const k of THICK) {
      expect(minorFraction(0, k)).toBeCloseTo(0, 12);
      expect(minorFraction(Math.PI, k)).toBeCloseTo(0.5, 12);
      expect(minorFraction(-Math.PI + 1e-9, k)).toBeCloseTo(-0.5, 6);
      expect(minorFraction(Math.PI / 2, k)).toBeLessThan(0.25); // bigger tiles outside: fewer of them
      let last = -1;
      for (let i = -99; i <= 100; i++) {
        const t = minorFraction((i / 100) * Math.PI, k);
        expect(t).toBeGreaterThan(last);
        last = t;
      }
    }
  });

  it("has the analytic rate dt/dφ (what the shader's S uses)", () => {
    for (const k of THICK) {
      for (let i = -9; i <= 9; i++) {
        const phi = (i / 10) * Math.PI;
        const h = 1e-6;
        const num = (minorFraction(phi + h, k) - minorFraction(phi - h, k)) / (2 * h);
        expect(minorRate(phi, k)).toBeCloseTo(num, 6);
      }
    }
  });

  it("is conformal: a plane unit is as long around the tube as along the ring, everywhere", () => {
    const c = counts();
    for (const g of ["p4", "p3"]) {
      for (const k of THICK) {
        latticeCounts(g, k, c);
        const err = (conformalAspect(k) * c.lx) / c.ly; // 1 but for the integer rounding of the counts
        for (let i = -8; i <= 8; i++) {
          const phi = (i / 8) * Math.PI;
          const along = ((1 + k * Math.cos(phi)) * 2 * Math.PI) / c.lx;
          const around = k / (c.ly * minorRate(phi, k));
          expect(around / along).toBeCloseTo(err, 9);
        }
      }
    }
  });

  it("maps (θ, φ) to the plane with the flow offsets, wrapping by whole periods at the seams", () => {
    const c = latticeCounts("p4", 0.38, counts());
    const a = [0, 0];
    const b = [0, 0];
    planePoint(0, 0, 0.38, c, 0.25, 0.5, a);
    expect(a[0]).toBeCloseTo(0.25 * c.lx, 12);
    expect(a[1]).toBeCloseTo(0.5 * c.ly, 12);
    planePoint(Math.PI - 1e-9, 0.3, 0.38, c, 0.1, 0, a);
    planePoint(-Math.PI + 1e-9, 0.3, 0.38, c, 0.1, 0, b);
    expect(a[0] - b[0]).toBeCloseTo(c.lx, 6);
    planePoint(0.7, Math.PI - 1e-9, 0.38, c, 0, 0.2, a);
    planePoint(0.7, -Math.PI + 1e-9, 0.38, c, 0, 0.2, b);
    expect(a[1] - b[1]).toBeCloseTo(c.ly, 6);
  });
});

const dot = (/** @type {ArrayLike<number>} */ a, /** @type {ArrayLike<number>} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (/** @type {ArrayLike<number>} */ a) => Math.sqrt(dot(a, a));
/** Signed distance to the torus (R = 1, tube k): negative inside the tube. */
const sdTorus = (/** @type {ArrayLike<number>} */ p, /** @type {number} */ k) => Math.hypot(Math.hypot(p[0], p[2]) - 1, p[1]) - k;

/** fwd, up unit and perpendicular. @param {ReturnType<typeof createPose>} pose */
function expectFrame(pose) {
  expect(len(pose.fwd)).toBeCloseTo(1, 9);
  expect(len(pose.up)).toBeCloseTo(1, 9);
  expect(dot(pose.fwd, pose.up)).toBeCloseTo(0, 9);
}

describe("inside fly path", () => {
  it("flies along the tube's centre circle, looking down the tube", () => {
    const pose = createPose();
    for (let i = 0; i < 24; i++) {
      const alpha = i * 0.61 - 3;
      insidePose(alpha, i * 0.4, 0, 0, pose);
      expectFrame(pose);
      expect(Math.hypot(pose.pos[0], pose.pos[2])).toBeCloseTo(1, 12);
      expect(pose.pos[1]).toBeCloseTo(0, 12);
      expect(Math.atan2(pose.pos[2], pose.pos[0])).toBeCloseTo(Math.atan2(Math.sin(alpha), Math.cos(alpha)), 9);
      // The heading is the circle's tangent, towards increasing θ.
      expect(pose.fwd[0]).toBeCloseTo(-Math.sin(alpha), 9);
      expect(pose.fwd[1]).toBeCloseTo(0, 9);
      expect(pose.fwd[2]).toBeCloseTo(Math.cos(alpha), 9);
      // Every wall is a tube radius away: the camera is centred in the tube.
      expect(sdTorus(pose.pos, 0.38)).toBeCloseTo(-0.38, 9);
    }
  });

  it("rolls about the heading, and looks around (yaw about up, pitch about right)", () => {
    const a = createPose();
    const b = createPose();
    insidePose(0.5, 0, 0, 0, a);
    insidePose(0.5, 0.9, 0, 0, b);
    expect(dot(a.fwd, b.fwd)).toBeCloseTo(1, 9);
    expect(dot(a.up, b.up)).toBeCloseTo(Math.cos(0.9), 9);
    insidePose(0.5, 0.9, 0.4, 0, a);
    expectFrame(a);
    expect(dot(a.fwd, b.fwd)).toBeCloseTo(Math.cos(0.4), 9);
    expect(dot(a.up, b.up)).toBeCloseTo(1, 9);
    insidePose(0.5, 0.9, 0, 0.3, a);
    expectFrame(a);
    expect(dot(a.fwd, b.fwd)).toBeCloseTo(Math.cos(0.3), 9);
    expect(dot(a.fwd, b.up)).toBeCloseTo(Math.sin(0.3), 9);
  });
});

describe("outside orbit", () => {
  it("sits on a sphere round the torus, looking at its centre, the up vector kept above", () => {
    const pose = createPose();
    for (let i = 0; i < 20; i++) {
      const az = i * 0.7;
      const el = -1 + i * 0.1;
      outsidePose(az, el, 3.4, pose);
      expectFrame(pose);
      expect(len(pose.pos)).toBeCloseTo(3.4, 9);
      expect(Math.asin(pose.pos[1] / 3.4)).toBeCloseTo(el, 9);
      for (let j = 0; j < 3; j++) expect(pose.fwd[j]).toBeCloseTo(-pose.pos[j] / 3.4, 9);
      expect(pose.up[1]).toBeGreaterThan(0);
    }
  });

  it("blends into the fly pose without a degenerate frame (heading and look are perpendicular)", () => {
    const out = createPose();
    const ins = createPose();
    const mix = createPose();
    for (let i = 0; i <= 20; i++) {
      outsidePose(1.1, 0.5, 3.4, out);
      insidePose(1.1, 0.2, 0, 0, ins);
      blendPose(out, ins, i / 20, i / 20, mix);
      expectFrame(mix);
      for (let j = 0; j < 3; j++) expect(mix.pos[j]).toBeCloseTo(out.pos[j] + (ins.pos[j] - out.pos[j]) * (i / 20), 9);
    }
    blendPose(out, ins, 0, 0, mix);
    for (let j = 0; j < 3; j++) expect(mix.fwd[j]).toBeCloseTo(out.fwd[j], 9);
    blendPose(out, ins, 1, 1, mix);
    for (let j = 0; j < 3; j++) expect(mix.up[j]).toBeCloseTo(ins.up[j], 9);
  });

  it("lets the heading lag the position (keeps looking at the torus while closing in)", () => {
    const out = createPose();
    const ins = createPose();
    const mix = createPose();
    outsidePose(1.1, 0.5, 3, out);
    insidePose(1.1, 0, 0, 0, ins);
    blendPose(out, ins, 0.5, 0, mix);
    for (let j = 0; j < 3; j++) expect(mix.fwd[j]).toBeCloseTo(out.fwd[j], 9);
    for (let j = 0; j < 3; j++) expect(mix.pos[j]).toBeCloseTo((out.pos[j] + ins.pos[j]) / 2, 9);
    expectFrame(mix);
  });

  it("the camera's heading still faces the torus's centre halfway through the dive", () => {
    const cam = createTorusCamera();
    const g = { travel: 0 };
    while (cam.mix < 0.3) cam.step(1 / 60, g, { view: "inside", thickness: 0.36, stepped: false, reduceMotion: false });
    const p = cam.pose.pos;
    const l = Math.hypot(p[0], p[1], p[2]);
    expect(-dot(cam.pose.fwd, p) / l).toBeGreaterThan(0.99);
  });
});

describe("view transition", () => {
  const DT = 1 / 60;
  const run = (/** @type {ReturnType<typeof createViewMix>} */ v, /** @type {number} */ secs, o = { view: "inside", stepped: false, reduceMotion: false }) => {
    const mix = [];
    for (let i = 0; i < Math.round(secs / DT); i++) mix.push(v.step(DT, o).mix);
    return mix;
  };

  it("maps the View param, unknown → auto", () => {
    expect(VIEWS).toEqual(["auto", "outside", "inside"]);
    expect(viewName("inside")).toBe("inside");
    expect(viewName("outside")).toBe("outside");
    expect(viewName("sideways")).toBe("auto");
  });

  it("starts outside and stays there with View outside", () => {
    const v = createViewMix();
    expect(Math.max(...run(v, 30, { view: "outside", stepped: false, reduceMotion: false }))).toBe(0);
  });

  it("dives in over several seconds with a smoothstep: slow out, slow in, never a jump", () => {
    expect(DIVE_TIME).toBeGreaterThanOrEqual(4);
    const v = createViewMix();
    const mix = run(v, DIVE_TIME + 1);
    const n = Math.round(DIVE_TIME / DT);
    expect(mix[n - 2]).toBeLessThan(1);
    expect(mix[n + 1]).toBe(1);
    let maxStep = 0;
    for (let i = 1; i < mix.length; i++) {
      expect(mix[i]).toBeGreaterThanOrEqual(mix[i - 1]);
      maxStep = Math.max(maxStep, mix[i] - mix[i - 1]);
    }
    expect(maxStep).toBeLessThanOrEqual((1.5 * DT) / DIVE_TIME + 1e-9); // smoothstep's peak slope
    expect(mix[1] - mix[0]).toBeLessThan(0.05 * maxStep); // eases out of rest…
    expect(mix[n - 1] - mix[n - 2]).toBeLessThan(0.05 * maxStep); // …and into it
    // and back out again the same way
    const back = run(v, DIVE_TIME + 1, { view: "outside", stepped: false, reduceMotion: false });
    expect(back[back.length - 1]).toBe(0);
  });

  it("takes twice as long with reduce motion", () => {
    const v = createViewMix();
    const mix = run(v, DIVE_TIME * 2 + 1, { view: "inside", stepped: false, reduceMotion: true });
    const n = Math.round(DIVE_TIME / DT);
    expect(mix[n]).toBeLessThan(0.6);
    expect(mix[mix.length - 1]).toBe(1);
  });

  it("auto: dives in on a phrase change (every PHRASE_STEPS bars), holds, and comes out on a later one", () => {
    const v = createViewMix();
    const o = { view: "auto", stepped: false, reduceMotion: false };
    // A bar every 2 s (120 BPM): a phrase is PHRASE_STEPS bars.
    const bar = Math.round(2 / DT);
    /** @type {number[]} */ const mix = [];
    for (let i = 0; i < bar * PHRASE_STEPS * 4; i++) {
      o.stepped = i % bar === bar - 1;
      mix.push(v.step(DT, o).mix);
    }
    const phrase = bar * PHRASE_STEPS;
    // Dives start on a phrase boundary, at least MIN_HOLD after the last change (or the start).
    const enter = mix.findIndex((m) => m > 0);
    expect((enter + 1) % phrase).toBe(0); // the bar step lands on the bar's last frame
    expect((enter + 1) * DT).toBeGreaterThanOrEqual(MIN_HOLD);
    expect((enter + 1 - phrase) * DT).toBeLessThan(MIN_HOLD); // the first such boundary
    expect(mix[enter + Math.round(DIVE_TIME / DT) + 1]).toBe(1);
    const leave = mix.findIndex((m, i) => i > enter && m < 1 && mix[i - 1] === 1);
    expect(leave).toBeGreaterThan(0);
    expect((leave + 1) % phrase).toBe(0);
    expect((leave - enter) * DT).toBeGreaterThanOrEqual(MIN_HOLD);
  });

  it("auto without music still changes view, slowly (every IDLE_TOGGLE s)", () => {
    const v = createViewMix();
    const mix = run(v, IDLE_TOGGLE + DIVE_TIME + 1, { view: "auto", stepped: false, reduceMotion: false });
    expect(mix[Math.round(IDLE_TOGGLE / DT) - 2]).toBe(0);
    expect(mix[mix.length - 1]).toBe(1);
  });
});

describe("wall fade (the dive goes through the paper)", () => {
  it("is 0 in the tube's centre and far outside, 1 on the wall, easing in between", () => {
    const k = 0.38;
    expect(wallFade([1, 0, 0], k)).toBe(0);
    expect(wallFade([3.4, 0, 0], k)).toBe(0);
    expect(wallFade([1 + k, 0, 0], k)).toBeCloseTo(1, 9);
    let last = 0;
    for (let i = 0; i <= 20; i++) {
      const f = wallFade([1 + (k * i) / 20, 0, 0], k);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    last = 1;
    for (let i = 0; i <= 40; i++) {
      const f = wallFade([1 + k + (2 * i) / 40, 0, 0], k);
      expect(f).toBeLessThanOrEqual(last);
      last = f;
    }
  });
});

describe("drag", () => {
  const DT = 1 / 60;
  /** @type {import('../../tidalviz').PointerInput} */
  const e = { kind: "down", x: 0, y: 0, dx: 0, dy: 0 };
  const ev = (/** @type {"down" | "move" | "up"} */ kind, x = 0, y = 0) => Object.assign(e, { kind, x, y });

  it("turns yaw and pitch with the pointer while held, pitch clamped", () => {
    const d = createDrag();
    d.pointer(ev("down", 100, 100));
    d.pointer(ev("move", 150, 80));
    d.step(DT);
    expect(d.yaw).toBeCloseTo(-50 * DRAG_RATE, 12);
    expect(d.pitch).toBeCloseTo(-20 * DRAG_RATE, 12);
    for (let i = 0; i < 120; i++) d.step(DT); // held still: stays
    expect(d.yaw).toBeCloseTo(-50 * DRAG_RATE, 12);
    d.pointer(ev("move", 150, 100 + 10 / DRAG_RATE));
    d.step(DT);
    expect(d.pitch).toBe(PITCH_LIMIT);
  });

  it("eases back to rest after release over DRAG_RETURN s: no jump at release, monotonic, then 0", () => {
    const d = createDrag();
    d.pointer(ev("down", 0, 0));
    d.pointer(ev("move", -200, 50));
    d.step(DT);
    const y0 = d.yaw;
    const p0 = d.pitch;
    d.pointer(ev("up", -200, 50));
    const ys = [];
    for (let i = 0; i < Math.round(DRAG_RETURN / DT) + 2; i++) ys.push(d.step(DT).yaw);
    expect(Math.abs(ys[0] - y0)).toBeLessThan(0.01 * Math.abs(y0));
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i])).toBeLessThanOrEqual(Math.abs(ys[i - 1]));
    expect(ys[ys.length - 1]).toBe(0);
    expect(d.pitch).toBe(0);
    expect(p0).not.toBe(0);
  });

  it("a new grab during the return picks up from where the view is", () => {
    const d = createDrag();
    d.pointer(ev("down", 0, 0));
    d.pointer(ev("move", 100, 0));
    d.step(DT);
    d.pointer(ev("up", 100, 0));
    for (let i = 0; i < 30; i++) d.step(DT);
    const mid = d.yaw;
    d.pointer(ev("down", 500, 500));
    d.step(DT);
    expect(d.yaw).toBeCloseTo(mid, 12);
    d.pointer(ev("move", 510, 500));
    d.step(DT);
    expect(d.yaw).toBeCloseTo(mid - 10 * DRAG_RATE, 12);
  });
});

describe("torus camera", () => {
  const DT = 1 / 60;
  const opts = (view = "inside", over = {}) => ({ view, thickness: 0.38, stepped: false, reduceMotion: false, ...over });
  /** Run with a glide of `speed` travel units per second. */
  function run(/** @type {ReturnType<typeof createTorusCamera>} */ cam, /** @type {number} */ secs, o = opts(), speed = 1, t0 = { travel: 0 }) {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      t0.travel += speed * DT;
      cam.step(DT, t0, o);
    }
    return t0;
  }

  it("flies along the centre circle once inside, as fast as the music's travel", () => {
    const cam = createTorusCamera();
    const g = run(cam, DIVE_TIME + 0.5);
    expect(cam.mix).toBe(1);
    expect(cam.side).toBe(-1);
    expect(Math.hypot(cam.pose.pos[0], cam.pose.pos[2])).toBeCloseTo(1, 9);
    expect(cam.pose.pos[1]).toBeCloseTo(0, 9);
    const a0 = cam.az;
    run(cam, 2, opts(), 1, g);
    expect(cam.az - a0).toBeCloseTo(FLY * 2, 6);
    const a1 = cam.az;
    run(cam, 2, opts(), 2.5, g); // a bass surge: faster
    expect(cam.az - a1).toBeCloseTo(FLY * 5, 6);
    const a2 = cam.az;
    run(cam, 2, opts(), 0, g); // Speed 0: still
    expect(cam.az).toBeCloseTo(a2, 12);
  });

  it("orbits slowly outside, at DIST, looking at the torus", () => {
    const cam = createTorusCamera();
    const g = run(cam, 1, opts("outside"));
    expect(cam.side).toBe(1);
    expect(cam.mix).toBe(0);
    expect(Math.hypot(...cam.pose.pos)).toBeCloseTo(DIST, 9);
    const a0 = cam.az;
    run(cam, 3, opts("outside"), 1, g);
    expect(cam.az - a0).toBeCloseTo(ORBIT * 3, 6);
    expect(cam.fade).toBe(0);
  });

  it("flows the tiles along the ring with the travel, wrapped to a turn", () => {
    const cam = createTorusCamera();
    run(cam, 1, opts("outside"));
    const f0 = cam.fu;
    run(cam, 1, opts("outside"), 1, { travel: 1 });
    expect(cam.fu - f0).toBeCloseTo(FLOW_U, 9);
    run(cam, 1, opts("outside"), 1 / (FLOW_U * DT * 60), { travel: 2 });
    expect(cam.fu).toBeGreaterThanOrEqual(0);
    expect(cam.fu).toBeLessThan(1);
    expect(cam.fv).toBeGreaterThanOrEqual(0);
    expect(cam.fv).toBeLessThan(1);
  });

  it("dissolves through the paper on the way in, clear before and after", () => {
    const cam = createTorusCamera();
    let peak = 0;
    let sides = new Set();
    const g = { travel: 0 };
    for (let i = 0; i < Math.round((DIVE_TIME + 1) / DT); i++) {
      g.travel += DT;
      cam.step(DT, g, opts());
      peak = Math.max(peak, cam.fade);
      sides.add(cam.side);
      expect(len(cam.pose.fwd)).toBeCloseTo(1, 9);
      expect(cam.tanHalf).toBeGreaterThan(0);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(cam.fade).toBe(0);
    expect([...sides].sort()).toEqual([-1, 1]);
  });

  it("starts the figure/ground front at the camera's azimuth (plane fraction, flow included)", () => {
    const cam = createTorusCamera();
    run(cam, 3, opts("outside"));
    const want = (((cam.az / (2 * Math.PI) + cam.fu) % 1) + 1) % 1;
    expect(cam.ringO).toBeCloseTo(want, 9);
  });

  it("drags orbit outside and turn the look inside, then ease back", () => {
    const cam = createTorusCamera();
    const g = run(cam, 1, opts("outside"));
    const e = { kind: /** @type {const} */ ("down"), x: 0, y: 0, dx: 0, dy: 0 };
    cam.pointer(e);
    cam.pointer({ ...e, kind: "move", x: -100 });
    run(cam, DT, opts("outside"), 0, g);
    const at = Math.atan2(cam.pose.pos[2], cam.pose.pos[0]);
    expect(at - cam.az).toBeCloseTo(100 * DRAG_RATE, 6);
    cam.pointer({ ...e, kind: "up", x: -100 });
    run(cam, DRAG_RETURN + 0.1, opts("outside"), 0, g);
    expect(Math.atan2(cam.pose.pos[2], cam.pose.pos[0])).toBeCloseTo(Math.atan2(Math.sin(cam.az), Math.cos(cam.az)), 6);
  });

  it("reduce motion slows the tumble", () => {
    const a = createTorusCamera();
    const b = createTorusCamera();
    run(a, 10, opts("outside"), 0);
    run(b, 10, opts("outside", { reduceMotion: true }), 0);
    const el = (/** @type {ReturnType<typeof createTorusCamera>} */ c) => Math.asin(c.pose.pos[1] / DIST);
    const start = createTorusCamera();
    run(start, DT, opts("outside"), 0);
    expect(Math.abs(el(b) - el(start))).toBeLessThan(0.5 * Math.abs(el(a) - el(start)));
  });
});

describe("params", () => {
  it("maps and clamps the manifest params", () => {
    const o = mapParams({ view: "inside", symmetry: "p3", thickness: 0.9, palette: "dusk", reactivity: 3, speed: -1, morph: 2, ink: 1.5, hatching: 0.4, quality: "low" }, {});
    expect(o).toMatchObject({ view: "inside", symmetry: "p3", thickness: THICKNESS.max, palette: "dusk", reactivity: 2, speed: 0, morph: 1, ink: 1.5, hatching: 0.4 });
    const d = mapParams({ view: "?", symmetry: "p6", thickness: "x", reactivity: "y" }, {});
    expect(d).toMatchObject({ view: "auto", symmetry: "p4", thickness: THICKNESS.default, reactivity: 1 });
    expect(mapParams({ thickness: 0 }, { thickness: 1 }).thickness).toBe(THICKNESS.min);
  });

  it("maps the wave params: Wave height 0–1, Travel time (s), Detail 0–1", () => {
    const o = mapParams({ wave: 1.4, travel: 20, detail: -1 }, {});
    expect(o).toMatchObject({ wave: 1, travel: TRAVEL.max, detail: 0 });
    const d = mapParams({ wave: "x", travel: "y", detail: "z" }, {});
    expect(d).toMatchObject({ wave: 0.7, travel: TRAVEL.default, detail: 0.15 });
    expect(mapParams({ travel: 0 }, { travel: 3 }).travel).toBe(TRAVEL.min);
    expect(TRAVEL.min).toBeGreaterThan(0);
  });
});
