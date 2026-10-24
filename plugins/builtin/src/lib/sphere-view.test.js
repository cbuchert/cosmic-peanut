// @ts-check
import { describe, expect, it } from "vitest";
import {
  cameraAt,
  cameraBasis,
  CLEARANCE,
  createDrag,
  createPush,
  D_IN,
  D_OUT,
  DRAG_RATE,
  fillOptions,
  MAX_DWELL,
  MIN_DWELL,
  PHRASE_STEPS,
  PITCH_LIMIT,
  planeToWorld,
  REDUCED_TRANSIT,
  reliefScale,
  sphereFrame,
  threeClassColors,
  TRANSIT,
  VIEWS,
  viewLight,
  viewName,
} from "./sphere-view.js";
import { CARD_HALF, CARD_RISE, paletteOf, MAX_TILE_COLORS, RELIEF_BLOCK } from "./tess.js";
import { FLIP_HOP, LIGHT_DEFAULT, LIGHT_ELEVATION, LIFT_GAIN, LIFT_VARY, POP_GAIN, POP_SLOTS } from "./tess-music.js";

const DT = 1 / 60;
const quiet = (/** @type {string} */ view, stepped = false, reduceMotion = false) => ({ view, stepped, reduceMotion });

describe("view param", () => {
  it("maps outside | inside | auto, unknown → auto", () => {
    expect(VIEWS).toEqual(["outside", "inside", "auto"]);
    expect(viewName("inside")).toBe("inside");
    expect(viewName("outside")).toBe("outside");
    expect(viewName("auto")).toBe("auto");
    expect(viewName("sideways")).toBe("auto");
    expect(viewName(undefined)).toBe("auto");
  });
});

describe("push (0 outside … 1 inside)", () => {
  it("starts where the view says, without a transition", () => {
    const a = createPush();
    a.step(DT, quiet("inside"));
    expect(a.value).toBe(1);
    const b = createPush();
    b.step(DT, quiet("outside"));
    expect(b.value).toBe(0);
    const c = createPush();
    c.step(DT, quiet("auto"));
    expect(c.value).toBe(0);
  });

  it("eases through the surface over TRANSIT seconds with a smoothstep: monotone, flat at both ends", () => {
    const p = createPush();
    p.step(DT, quiet("outside"));
    /** @type {number[]} */
    const v = [];
    for (let t = 0; t < TRANSIT + 1; t += DT) v.push(p.step(DT, quiet("inside")).value);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
    // Flat start and end (no click): the first and last steps move far less than the middle one.
    const mid = Math.round(TRANSIT / 2 / DT);
    const midStep = v[mid] - v[mid - 1];
    expect(v[1] - v[0]).toBeLessThan(midStep * 0.05);
    const end = Math.round(TRANSIT / DT) - 1;
    expect(v[end] - v[end - 1]).toBeLessThan(midStep * 0.05);
    expect(v[Math.round(TRANSIT / DT) - 2]).toBeLessThan(1);
    expect(v[v.length - 1]).toBe(1);
    expect(v[mid]).toBeCloseTo(0.5, 1);
  });

  it("turns around from where it is when the view changes mid-way (never jumps)", () => {
    const p = createPush();
    p.step(DT, quiet("outside"));
    for (let t = 0; t < TRANSIT / 2; t += DT) p.step(DT, quiet("inside"));
    const at = p.value;
    expect(at).toBeGreaterThan(0.3);
    const next = p.step(DT, quiet("outside")).value;
    expect(Math.abs(next - at)).toBeLessThan(0.01);
    for (let t = 0; t < TRANSIT + 1; t += DT) p.step(DT, quiet("outside"));
    expect(p.value).toBe(0);
  });

  it("auto: pushes in on a phrase change (every PHRASE_STEPS morph steps) and back out on a later one", () => {
    const p = createPush();
    p.step(DT, quiet("auto"));
    let steps = 0;
    let t = 0;
    /** Run until `until` s, a morph step every 2 s (a bar at 120 BPM). */
    const run = (/** @type {number} */ until) => {
      for (; t < until; t += DT) {
        const stepped = Math.floor((t + DT) / 2) > Math.floor(t / 2);
        if (stepped) steps++;
        p.step(DT, quiet("auto", stepped));
      }
    };
    run(PHRASE_STEPS * 2 - 0.1);
    expect(p.target).toBe(0); // first phrase at 16 s; MIN_DWELL is at most that
    run(PHRASE_STEPS * 2 + 0.1);
    expect(p.target).toBe(1);
    run(PHRASE_STEPS * 2 + TRANSIT + 0.2);
    expect(p.value).toBe(1);
    run(PHRASE_STEPS * 4 + 0.1);
    expect(p.target).toBe(0);
    expect(steps).toBeGreaterThanOrEqual(PHRASE_STEPS * 2);
  });

  it("auto: waits at least MIN_DWELL between moves, and goes anyway after MAX_DWELL of no phrases", () => {
    const p = createPush();
    p.step(DT, quiet("auto"));
    // A phrase's worth of steps all at once, too soon.
    for (let i = 0; i < PHRASE_STEPS; i++) p.step(DT, quiet("auto", true));
    expect(MIN_DWELL).toBeGreaterThan(1);
    expect(p.target).toBe(0);
    let t = 0;
    for (; t < MAX_DWELL - 0.5; t += DT) p.step(DT, quiet("auto"));
    expect(p.target).toBe(0);
    for (; t < MAX_DWELL + 0.5; t += DT) p.step(DT, quiet("auto"));
    expect(p.target).toBe(1);
  });

  it("reduce motion: the transit takes REDUCED_TRANSIT × as long", () => {
    const p = createPush();
    p.step(DT, quiet("outside", false, true));
    let t = 0;
    while (p.value < 0.5 && t < 100) {
      p.step(DT, quiet("inside", false, true));
      t += DT;
    }
    expect(t).toBeCloseTo((TRANSIT * REDUCED_TRANSIT) / 2, 0);
  });
});

describe("camera", () => {
  const cam = { dist: 0, fov: 0, veil: 0, inside: 0 };

  it("goes from D_OUT (outside, narrow) to D_IN (inside, wide), crossing the surface on the way", () => {
    cameraAt(0, cam);
    expect(cam.dist).toBe(D_OUT);
    expect(cam.inside).toBe(0);
    const fovOut = cam.fov;
    cameraAt(1, cam);
    expect(cam.dist).toBe(D_IN);
    expect(cam.inside).toBe(1);
    expect(cam.fov).toBeGreaterThan(fovOut * 1.5);
    expect(D_OUT).toBeGreaterThan(2);
    expect(D_IN).toBeLessThan(0.6);
  });

  it("veils the print in paper only close to the surface, so the push-through is soft", () => {
    cameraAt(0, cam);
    expect(cam.veil).toBe(0);
    cameraAt(1, cam);
    expect(cam.veil).toBe(0);
    let peak = 0;
    let prev = 0;
    let jumps = 0;
    for (let x = 0; x <= 1; x += 0.001) {
      cameraAt(x, cam);
      if (Math.abs(cam.veil - prev) > 0.05) jumps++;
      prev = cam.veil;
      peak = Math.max(peak, cam.veil);
      if (Math.abs(cam.dist - 1) < 0.005) expect(cam.veil).toBeGreaterThan(0.95);
    }
    expect(peak).toBeCloseTo(1, 2);
    expect(jumps).toBe(0);
  });

  it("builds an orthonormal basis looking at the centre (orbit), turned by the look angles", () => {
    const b = new Float32Array(12);
    cameraBasis(3, 0.4, 0.2, 0, 0, b);
    const eye = [b[0], b[1], b[2]];
    expect(Math.hypot(...eye)).toBeCloseTo(3, 5);
    const fwd = [b[9], b[10], b[11]];
    // Looks at the origin.
    for (let i = 0; i < 3; i++) expect(fwd[i]).toBeCloseTo(-eye[i] / 3, 5);
    const ortho = (/** @type {Float32Array} */ m) => {
      for (let i = 1; i < 4; i++) {
        expect(Math.hypot(m[i * 3], m[i * 3 + 1], m[i * 3 + 2])).toBeCloseTo(1, 5);
        for (let j = i + 1; j < 4; j++) expect(m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2]).toBeCloseTo(0, 5);
      }
    };
    ortho(b);
    // Looking around turns the view away from the centre but keeps the eye.
    const c = new Float32Array(12);
    cameraBasis(3, 0.4, 0.2, 0.5, -0.3, c);
    ortho(c);
    expect(c[0]).toBeCloseTo(b[0], 6);
    const cos = b[9] * c[9] + b[10] * c[10] + b[11] * c[11];
    expect(cos).toBeLessThan(0.95);
  });
});

describe("drag", () => {
  /** @type {import('../../tidalviz').PointerInput} */
  const e = { kind: "down", x: 100, y: 100, dx: 0, dy: 0 };

  it("turns with the drag (yaw from x, pitch from y), pitch clamped", () => {
    const d = createDrag();
    d.pointer({ ...e, kind: "down" });
    d.pointer({ ...e, kind: "move", x: 160, y: 80 });
    expect(d.yaw).toBeGreaterThan(0.1);
    expect(d.yaw).toBeCloseTo(60 * DRAG_RATE, 9);
    expect(d.pitch).toBeCloseTo(20 * DRAG_RATE, 9);
    d.pointer({ ...e, kind: "move", x: 160, y: -5000 });
    expect(d.pitch).toBe(PITCH_LIMIT);
    // Held: stepping doesn't ease it back.
    for (let i = 0; i < 60; i++) d.step(DT, false);
    expect(d.pitch).toBe(PITCH_LIMIT);
  });

  it("eases back to rest after release: starts gently, never overshoots, settles in a few seconds", () => {
    const d = createDrag();
    d.pointer({ ...e, kind: "down" });
    d.pointer({ ...e, kind: "move", x: 300, y: 100 });
    d.pointer({ ...e, kind: "up", x: 300, y: 100 });
    const y0 = d.yaw;
    d.step(DT, false);
    const first = y0 - d.yaw;
    let prev = d.yaw;
    let biggest = first;
    for (let t = 0; t < 4; t += DT) {
      d.step(DT, false);
      expect(d.yaw).toBeGreaterThanOrEqual(0);
      expect(d.yaw).toBeLessThanOrEqual(prev);
      biggest = Math.max(biggest, prev - d.yaw);
      prev = d.yaw;
    }
    expect(first).toBeLessThan(biggest * 0.2);
    expect(d.yaw).toBeLessThan(y0 * 0.02);
  });

  it("reduce motion eases back more slowly", () => {
    const a = createDrag();
    const b = createDrag();
    for (const d of [a, b]) {
      d.pointer({ ...e, kind: "down" });
      d.pointer({ ...e, kind: "move", x: 300, y: 100 });
      d.pointer({ ...e, kind: "up", x: 300, y: 100 });
    }
    for (let t = 0; t < 1; t += DT) {
      a.step(DT, false);
      b.step(DT, true);
    }
    expect(b.yaw).toBeGreaterThan(a.yaw * 1.5);
  });
});

describe("sphere frame", () => {
  it("is a rotation (orthonormal, det +1) that turns with the spin", () => {
    const m = new Float32Array(9);
    const n = new Float32Array(9);
    sphereFrame(0.7, 0.3, m);
    const col = (/** @type {Float32Array} */ a, /** @type {number} */ i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    const [x, y, z] = [col(m, 0), col(m, 1), col(m, 2)];
    const det = x[0] * (y[1] * z[2] - y[2] * z[1]) - y[0] * (x[1] * z[2] - x[2] * z[1]) + z[0] * (x[1] * y[2] - x[2] * y[1]);
    expect(det).toBeCloseTo(1, 5);
    for (const c of [x, y, z]) expect(Math.hypot(...c)).toBeCloseTo(1, 5);
    sphereFrame(0.7 + 0.5, 0.3, n);
    let same = 0;
    for (let i = 0; i < 9; i++) same += Math.abs(m[i] - n[i]);
    expect(same).toBeGreaterThan(0.1);
  });
});

describe("param mapping", () => {
  it("fills the tess options: always p4 (the cube's quarter turns), numbers from the params", () => {
    const o = { symmetry: "", palette: "", reactivity: 0, speed: 0, morph: 0, ink: 0, hatching: 0, height: 0, reduceMotion: false, reduceFlashing: false, relief: 0 };
    const ctx = { params: { symmetry: "p3", palette: "dusk", reactivity: "1.5", speed: 0.5, morph: 0.2, ink: 1.2, hatching: 0.4, relief: "0.6" }, size: { height: 1440 }, reduceMotion: true, reduceFlashing: false };
    fillOptions(ctx, o);
    expect(o).toEqual({ symmetry: "p4", palette: "dusk", reactivity: 1.5, speed: 0.5, morph: 0.2, ink: 1.2, hatching: 0.4, height: 1440, reduceMotion: true, reduceFlashing: false, relief: 0.6 });
  });

  it("maps Relief onto 0–1 (0 is the flat print, as before relief; junk is 0)", () => {
    const o = { symmetry: "", palette: "", reactivity: 0, speed: 0, morph: 0, ink: 0, hatching: 0, height: 0, reduceMotion: false, reduceFlashing: false, relief: 0 };
    const at = (/** @type {unknown} */ relief) => fillOptions({ params: { relief }, size: { height: 720 }, reduceMotion: false, reduceFlashing: false }, o).relief;
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(1);
    expect(at(0.25)).toBe(0.25);
    expect(at(3)).toBe(1);
    expect(at(-1)).toBe(0);
    expect(at("x")).toBe(0);
    expect(at(undefined)).toBe(0);
  });

  it("turns Light round the view: a unit vector LIGHT_ELEVATION towards the viewer, upper left by default", () => {
    const basis = cameraBasis(D_OUT, 0.4, 0.2, 0, 0, new Float32Array(12));
    const L = viewLight(LIGHT_DEFAULT, basis, new Float32Array(3));
    const along = (/** @type {number} */ o) => L[0] * basis[o] + L[1] * basis[o + 1] + L[2] * basis[o + 2];
    expect(Math.hypot(L[0], L[1], L[2])).toBeCloseTo(1, 6);
    expect(along(3)).toBeLessThan(0); // left
    expect(along(6)).toBeGreaterThan(0); // up
    expect(-along(9)).toBeCloseTo(Math.sin(LIGHT_ELEVATION), 6); // towards the viewer
    const R = viewLight(0, basis, new Float32Array(3));
    expect(R[0] * basis[3] + R[1] * basis[4] + R[2] * basis[5]).toBeCloseTo(Math.cos(LIGHT_ELEVATION), 6);
  });


  it("gives three classes distinct linear colours that move one palette slot per shift", () => {
    const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
    const n = paletteOf("ink", pal);
    expect(n).toBeGreaterThanOrEqual(3);
    const now = new Float32Array(9);
    const next = new Float32Array(9);
    threeClassColors(pal, n, 0, now, next);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 3; i++) expect(now[c * 3 + i]).toBeCloseTo(Math.pow(pal[6 + c * 3 + i], 2.2), 5);
      for (let d = c + 1; d < 3; d++) expect(Math.abs(now[c * 3] - now[d * 3]) + Math.abs(now[c * 3 + 1] - now[d * 3 + 1])).toBeGreaterThan(0.01);
    }
    const shifted = new Float32Array(9);
    threeClassColors(pal, n, 1, shifted, next);
    for (let i = 0; i < 6; i++) expect(shifted[i]).toBeCloseTo(now[i + 3], 6);
  });
});


describe("relief clearance (the tiles lift outward outside, inward inside)", () => {
  const N = 3;
  const cam = { dist: 0, fov: 0, veil: 0, inside: 0 };
  // The tallest the block can stand (lib/tess-music.js reliefBound at Relief 1, Reactivity 2, every
  // pop at once, a card turning): the clearance must hold even then.
  const most = RELIEF_BLOCK + 2 * LIFT_GAIN * 1.5 * (1 + LIFT_VARY) + 0.14 + POP_SLOTS * POP_GAIN * 2 + CARD_RISE * (2 * CARD_HALF + FLIP_HOP);

  it("converts plane units to world units by the face's angle: N cells span a quarter turn", () => {
    expect(planeToWorld(N)).toBeCloseTo(Math.PI / 2 / N, 12);
  });

  it("keeps full relief where the camera sits outside and inside", () => {
    for (const bound of [0.05, 0.2, 0.4]) {
      expect(reliefScale(D_OUT, bound, N)).toBeCloseTo(planeToWorld(N), 12);
      expect(reliefScale(D_IN, bound, N)).toBeCloseTo(planeToWorld(N), 12);
    }
    // Loud music at Relief 1 (a bar's beat at the lift cap, heave, a card turning): still full.
    const loud = RELIEF_BLOCK + LIFT_GAIN * 1.5 * (1 + LIFT_VARY) + 0.07 + CARD_RISE * (2 * CARD_HALF + FLIP_HOP);
    expect(reliefScale(D_IN, loud, N)).toBeCloseTo(planeToWorld(N), 12);
    expect(reliefScale(D_OUT, most, N)).toBeCloseTo(planeToWorld(N), 12);
    // Even the tallest block, inside, stays CLEARANCE from the eye.
    expect(1 - D_IN - reliefScale(D_IN, most, N) * most).toBeGreaterThanOrEqual(CLEARANCE - 1e-12);
  });

  it("never brings the relief within CLEARANCE of the eye, all the way through a push", () => {
    for (const bound of [0, 0.01, 0.1, 0.3, most]) {
      let last = reliefScale(cameraAt(0, cam).dist, bound, N);
      for (let i = 0; i <= 2000; i++) {
        cameraAt(i / 2000, cam);
        const k = reliefScale(cam.dist, bound, N);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(planeToWorld(N) + 1e-12);
        // The shell spans radius 1 … 1 + k·bound outside, 1 − k·bound … 1 inside.
        const shell = k * bound;
        expect(shell).toBeLessThanOrEqual(Math.max(0, Math.abs(cam.dist - 1) - CLEARANCE) + 1e-12);
        // It flattens and comes back smoothly: no jump from frame to frame of a 6 s push.
        expect(Math.abs(k * bound - last * bound)).toBeLessThan(0.01);
        last = k;
      }
    }
  });

  it("is flat as the camera crosses the skin, so turning the tiles inward there shows no jump", () => {
    for (const bound of [0.1, most]) {
      expect(reliefScale(1, bound, N)).toBe(0);
      expect(reliefScale(1 + 0.5 * CLEARANCE, bound, N)).toBe(0);
      expect(reliefScale(1 - 0.5 * CLEARANCE, bound, N)).toBe(0);
    }
  });
});
