// @ts-check
import { describe, expect, it } from "vitest";
import { cameraDistance, createCamera, FOV, fitTrack } from "./camera.js";
import { TRACKS, TRACK_SAMPLES, buildTrack } from "./track.js";

/**
 * Run the camera for `seconds` at `hz`.
 * @param {ReturnType<typeof createCamera>} cam @param {number} seconds @param {number} orbit
 */
function run(cam, seconds, orbit, hz = 60) {
  for (let f = 0; f < Math.round(seconds * hz); f++) cam.update(1 / hz, orbit);
}

describe("createCamera", () => {
  it("yaws at the orbit speed: a full turn takes about 52 s at 0.12 rad/s", () => {
    const cam = createCamera();
    const yaw0 = cam.yaw;
    run(cam, 52.36, 0.12);
    expect(cam.yaw - yaw0).toBeCloseTo(2 * Math.PI, 2);
    run(cam, 10, -0.3);
    expect(cam.yaw - yaw0).toBeCloseTo(2 * Math.PI - 3, 2);
  });

  it("sways pitch as basePitch + 0.3·sin(0.09·t), t scaled by |orbit| ÷ 0.12", () => {
    const cam = createCamera();
    expect(cam.pitch).toBeCloseTo(0.42, 9);
    run(cam, 10, 0.12);
    expect(cam.pitch).toBeCloseTo(0.42 + 0.3 * Math.sin(0.9), 6);
    run(cam, 10, -0.06); // half speed: t advances 5 s
    expect(cam.pitch).toBeCloseTo(0.42 + 0.3 * Math.sin(0.09 * 15), 6);
    const still = cam.pitch;
    run(cam, 10, 0); // stopping the orbit stops the sway
    expect(cam.pitch).toBe(still);
  });

  it("clamps pitch to ±1.3 rad", () => {
    const cam = createCamera();
    cam.basePitch = 1.2;
    let hi = -Infinity;
    for (let f = 0; f < 60 * 120; f++) {
      cam.update(1 / 60, 0.6);
      hi = Math.max(hi, Math.abs(cam.pitch));
    }
    expect(hi).toBe(1.3);
  });

  it("drags at 0.006 rad/px (horizontal → yaw, vertical → pitch) and holds the orbit meanwhile", () => {
    const cam = createCamera();
    run(cam, 3, 0.12);
    const { yaw, pitch } = cam;
    const e = { kind: /** @type {"down" | "move" | "up"} */ ("down"), x: 100, y: 100, dx: 0, dy: 0 };
    cam.pointer(e);
    Object.assign(e, { kind: "move", x: 150, y: 80, dx: 50, dy: -20 });
    cam.pointer(e);
    expect(cam.yaw).toBeCloseTo(yaw - 50 * 0.006, 9);
    expect(cam.pitch).toBeCloseTo(pitch - 20 * 0.006, 9);
    run(cam, 1, 0.12); // no self-orbit while dragging
    expect(cam.yaw).toBeCloseTo(yaw - 50 * 0.006, 9);
    Object.assign(e, { kind: "move", x: 150, y: 1000, dx: 0, dy: 920 });
    cam.pointer(e);
    expect(cam.pitch).toBe(1.3);
  });

  it("resumes the orbit from where the drag let go, with no jump", () => {
    const cam = createCamera();
    run(cam, 7, 0.12);
    const e = { kind: /** @type {"down" | "move" | "up"} */ ("down"), x: 0, y: 0, dx: 0, dy: 0 };
    cam.pointer(e);
    Object.assign(e, { kind: "move", x: -200, y: 150, dx: -200, dy: 150 });
    cam.pointer(e);
    Object.assign(e, { kind: "up", dx: 0, dy: 0 });
    cam.pointer(e);
    const { yaw, pitch } = cam;
    cam.update(1 / 60, 0.12);
    expect(cam.yaw - yaw).toBeCloseTo(0.12 / 60, 9);
    expect(Math.abs(cam.pitch - pitch)).toBeLessThan(0.001);
  });
});

describe("cameraDistance", () => {
  it("fits the sphere at maximum swell with a 1.32 margin in a 38° vertical field of view", () => {
    expect(FOV).toBeCloseTo((38 * Math.PI) / 180, 12);
    const fit = ((1 + 0.22) * 1.32) / Math.tan((19 * Math.PI) / 180);
    expect(cameraDistance(0.22, 16 / 9)).toBeCloseTo(fit, 9);
    expect(cameraDistance(0.22, 1)).toBeCloseTo(fit, 9);
  });

  it("backs off by the aspect ratio in portrait so nothing clips at the sides", () => {
    const fit = ((1 + 0.6) * 1.32) / Math.tan((19 * Math.PI) / 180);
    expect(cameraDistance(0.6, 9 / 16)).toBeCloseTo(fit / (9 / 16), 9);
  });
});

// The prototype's allocating matrix helpers, kept as the reference.
/** @param {number} fovy @param {number} aspect @param {number} near @param {number} far */
function refPerspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
/** @param {number[]} e */
function refLookAt(e) {
  const len = Math.hypot(e[0], e[1], e[2]);
  const z = [e[0] / len, e[1] / len, e[2] / len];
  let x = [z[2], 0, -z[0]];
  const xl = Math.hypot(x[0], x[2]) || 1;
  x = [x[0] / xl, 0, x[2] / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]),
    -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]),
    -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]),
    1,
  ];
}

describe("camera matrices", () => {
  it("match the prototype's perspective and look-at, written into preallocated arrays", () => {
    const cam = createCamera();
    const { proj, view } = cam;
    expect(proj).toBeInstanceOf(Float32Array);
    for (const [yaw, pitch, aspect] of [[0.4, 0.42, 16 / 9], [-2.1, -1.3, 0.6], [5, 1.3, 1]]) {
      cam.yaw = yaw;
      cam.pitch = pitch;
      const dist = cameraDistance(0.22, aspect);
      cam.writeMatrices(aspect, dist);
      expect(cam.proj).toBe(proj);
      expect(cam.view).toBe(view);
      const eye = [
        dist * Math.cos(pitch) * Math.sin(yaw),
        dist * Math.sin(pitch),
        dist * Math.cos(pitch) * Math.cos(yaw),
      ];
      const P = refPerspective(FOV, aspect, 0.1, 50);
      const V = refLookAt(eye);
      for (let k = 0; k < 16; k++) {
        expect(proj[k]).toBeCloseTo(P[k], 5);
        expect(view[k]).toBeCloseTo(V[k], 5);
      }
    }
  });
});

describe("fitTrack", () => {
  /**
   * Largest |ndc x| and |ndc y| of the strip's edges (± amp along the surface normal) over a fine
   * orbit sweep (every yaw, pitch 0.12…0.72 as the sway goes), through the real camera matrices.
   * @param {ReturnType<typeof buildTrack>} tr @param {number} W @param {number} amp
   * @param {number} aspect @param {number} dist
   */
  function sweep(tr, W, amp, aspect, dist) {
    const K = TRACK_SAMPLES;
    const d = tr.data;
    const cam = createCamera();
    let mx = 0;
    let my = 0;
    for (let yi = 0; yi < 90; yi++) {
      for (let pi = 0; pi <= 6; pi++) {
        cam.yaw = (2 * Math.PI * yi) / 90;
        cam.pitch = 0.12 + (0.6 * pi) / 6;
        cam.writeMatrices(aspect, dist);
        const P = cam.proj;
        const V = cam.view;
        for (let k = 0; k < K; k += 3) {
          const c = [d[k * 4], d[k * 4 + 1], d[k * 4 + 2]];
          const t = [d[(K + k) * 4], d[(K + k) * 4 + 1], d[(K + k) * 4 + 2]];
          const w = [d[(2 * K + k) * 4], d[(2 * K + k) * 4 + 1], d[(2 * K + k) * 4 + 2]];
          const n = [t[1] * w[2] - t[2] * w[1], t[2] * w[0] - t[0] * w[2], t[0] * w[1] - t[1] * w[0]];
          for (const v of [-W, W]) {
            for (const a of [-amp, amp]) {
              const p = [0, 1, 2].map((i) => c[i] + v * w[i] + a * n[i]);
              const e = [0, 1, 2].map((r) => V[r] * p[0] + V[4 + r] * p[1] + V[8 + r] * p[2] + V[12 + r]);
              const cw = -e[2];
              mx = Math.max(mx, Math.abs((P[0] * e[0]) / cw));
              my = Math.max(my, Math.abs((P[5] * e[1]) / cw));
            }
          }
        }
      }
    }
    return { mx, my };
  }

  for (const name of TRACKS) {
    it(`${name}: fills 70–80% of the shorter screen side while orbiting, never clipping the longer`, () => {
      const tr = buildTrack(name);
      for (const aspect of [16 / 9, 1, 9 / 16]) {
        const dist = fitTrack(tr, 0.4, 0.22, aspect);
        const { mx, my } = sweep(tr, 0.4, 0.22, aspect, dist);
        const [short, long] = aspect >= 1 ? [my, mx] : [mx, my];
        expect(short, `${name} ${aspect.toFixed(2)} short side`).toBeGreaterThan(0.7);
        expect(short, `${name} ${aspect.toFixed(2)} short side`).toBeLessThan(0.8);
        expect(long, `${name} ${aspect.toFixed(2)} long side`).toBeLessThan(0.92);
      }
    });
  }

  it("backs off for a wider strip and a bigger amplitude", () => {
    const tr = buildTrack("figure-8");
    expect(fitTrack(tr, 0.6, 0.22, 16 / 9)).toBeGreaterThan(fitTrack(tr, 0.4, 0.22, 16 / 9));
    expect(fitTrack(tr, 0.4, 0.5, 16 / 9)).toBeGreaterThan(fitTrack(tr, 0.4, 0.22, 16 / 9));
  });
});
