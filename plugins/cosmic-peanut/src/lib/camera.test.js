// @ts-check
import { describe, expect, it } from "vitest";
import { cameraDistance, createCamera, FOV } from "./camera.js";

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
