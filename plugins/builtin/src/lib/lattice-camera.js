// @ts-check
/**
 * Lattice's camera: flies forward through the empty channels of the cubic lattice.
 *
 * World units are cells: nodes (cubes) sit at integer points and rods run along the axes between
 * them, so the cell centres (all three coordinates half-integers) are the points farthest from
 * any geometry and the lines through them, parallel to an axis, are free channels. The path is a
 * seeded walk from cell centre to adjacent cell centre (a run of 2–5 cells, then a turn to one of
 * the four perpendicular axes, never back), smoothed by a uniform cubic B-spline over those
 * points. The spline is C2 (no jerk), passes within 1/6 cell of each control point, and cuts each
 * corner by under 0.25 cell, so it stays ≥ 0.47 cell from every rod axis. The camera moves along
 * it by arc length, so its speed is exactly the speed asked for. It looks at the path point
 * LOOK_AHEAD cells on, so the view starts turning before the corner and turns about half as fast
 * as the path; `up` is carried along by parallel transport (no roll of its own, never degenerate
 * when the path climbs straight up). Dragging turns the view about that heading (the scene follows
 * the pointer); on release a critically damped spring eases it back, Möbius Field's `fly.js` rule.
 *
 * Nothing is allocated per update.
 */
import { prng } from "./tiedye.js";

/** Control points kept: the current segment uses the first four, the rest serve look-ahead. */
const RING = 8;
/** Cells in a straight run between turns. */
const RUN_MIN = 2;
const RUN_MAX = 5;
/** The view looks at the path this far ahead (cells): turns are seen coming and spread out. */
export const LOOK_AHEAD = 1.2;
/** Substeps of the look-ahead march (equal-sized, so the target moves smoothly with the camera). */
const AHEAD_STEPS = 24;
/** Look-around drag, radians per CSS pixel. */
export const LOOK_RATE = 0.004;
/** Most look-around pitch either way, radians. */
export const LOOK_PITCH = 1.1;
/** The release spring's rate (1/s): critically damped, so it starts from rest and never overshoots. */
const RETURN = 2.5;
/** Longest arc-length step per substep (cells), so fast frames stay on the curve. */
const MAX_STEP = 0.05;

/** The six axis directions: +x, −x, +y, −y, +z, −z. */
const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Uniform cubic B-spline basis at u (0–1), and its derivative, into `w` (8 floats).
 * @param {number} u @param {Float64Array} w
 */
function basis(u, w) {
  const v = 1 - u;
  const u2 = u * u;
  const u3 = u2 * u;
  w[0] = (v * v * v) / 6;
  w[1] = (3 * u3 - 6 * u2 + 4) / 6;
  w[2] = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6;
  w[3] = u3 / 6;
  w[4] = (-v * v) / 2;
  w[5] = (3 * u2 - 4 * u) / 2;
  w[6] = (-3 * u2 + 2 * u + 1) / 2;
  w[7] = u2 / 2;
}

/** @type {[number, number]} reused by {@link settle} */
const spring = [0, 0];

/**
 * One critically damped step toward 0 from (x, v) over dt, exact for any dt, into `spring`.
 * @param {number} x @param {number} v @param {number} dt
 */
function settle(x, v, dt) {
  const b = v + RETURN * x;
  const e = Math.exp(-RETURN * dt);
  spring[0] = (x + b * dt) * e;
  spring[1] = (b - RETURN * (x + b * dt)) * e;
}

/** @param {number} seed */
export function createCamera(seed) {
  const rand = prng(seed);
  /** Control points, x y z per point, oldest first (a ring starting at `first`). */
  const pts = new Float64Array(RING * 3);
  let first = 0;
  let dir = 4; // +z
  let run = RUN_MIN;
  const w = new Float64Array(8);
  /** The current segment (between control points 1 and 2 of the ring) and the place along it. */
  let u = 0;

  /** Append the next walk point after point `prev` (ring index) into ring slot `slot`. */
  function walk(/** @type {number} */ prev, /** @type {number} */ slot) {
    if (--run <= 0) {
      const axis = dir >> 1;
      // One of the four directions on the other two axes.
      const k = Math.floor(rand() * 4);
      const other = (axis + 1 + (k >> 1)) % 3;
      dir = other * 2 + (k & 1);
      run = RUN_MIN + Math.floor(rand() * (RUN_MAX - RUN_MIN + 1));
    }
    const d = DIRS[dir];
    for (let c = 0; c < 3; c++) pts[slot * 3 + c] = pts[prev * 3 + c] + d[c];
  }

  // Start in a channel, the first points straight ahead.
  for (let c = 0; c < 3; c++) pts[c] = 0.5;
  run = RUN_MAX + 1;
  for (let i = 1; i < RING; i++) walk(i - 1, i);

  /**
   * Evaluate segment `seg` (0 = the current one) at `t` into `out` (position) and `tan`
   * (derivative, cells per unit t). @param {number} seg @param {number} t
   * @param {Float64Array} out @param {Float64Array} tan
   */
  function evaluate(seg, t, out, tan) {
    basis(t, w);
    for (let c = 0; c < 3; c++) {
      let p = 0;
      let d = 0;
      for (let k = 0; k < 4; k++) {
        const v = pts[((first + seg + k) % RING) * 3 + c];
        p += w[k] * v;
        d += w[4 + k] * v;
      }
      out[c] = p;
      tan[c] = d;
    }
  }

  const tan = new Float64Array(3);
  const tmp = new Float64Array(3);
  const tmpTan = new Float64Array(3);

  /**
   * The path point `dist` cells ahead of the camera, into `out`: a fixed number of midpoint
   * steps by arc length across the segments still in the ring.
   * @param {number} dist @param {Float64Array} out
   */
  function ahead(dist, out) {
    let seg = 0;
    let t = u;
    const ds = dist / AHEAD_STEPS;
    for (let i = 0; i < AHEAD_STEPS; i++) {
      evaluate(seg, t, tmp, tmpTan);
      const half = t + (0.5 * ds) / Math.max(1e-6, Math.hypot(tmpTan[0], tmpTan[1], tmpTan[2]));
      evaluate(seg, Math.min(half, 1), tmp, tmpTan);
      t += ds / Math.max(1e-6, Math.hypot(tmpTan[0], tmpTan[1], tmpTan[2]));
      while (t >= 1 && seg < RING - 4) {
        t -= 1;
        seg++;
      }
    }
    evaluate(seg, Math.min(t, 1), out, tmpTan);
    return out;
  }

  const target = new Float64Array(3);
  /** Point the view at the look-ahead target; carry `up` along, then complete the basis. */
  function orient() {
    ahead(LOOK_AHEAD, target);
    const f = cam.fwd;
    for (let c = 0; c < 3; c++) f[c] = target[c] - cam.pos[c];
    const fl = Math.hypot(f[0], f[1], f[2]);
    for (let c = 0; c < 3; c++) f[c] /= fl;
    const up = cam.up;
    const d = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
    for (let c = 0; c < 3; c++) up[c] -= d * f[c];
    const ul = Math.hypot(up[0], up[1], up[2]);
    for (let c = 0; c < 3; c++) up[c] /= ul;
    const r = cam.right;
    r[0] = f[1] * up[2] - f[2] * up[1];
    r[1] = f[2] * up[0] - f[0] * up[2];
    r[2] = f[0] * up[1] - f[1] * up[0];
  }

  let dragging = false;
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  let vYaw = 0;
  let vPitch = 0;

  /** The path basis turned by the look-around into `cam.view`. */
  function look() {
    const cy = Math.cos(cam.lookYaw);
    const sy = Math.sin(cam.lookYaw);
    const cp = Math.cos(cam.lookPitch);
    const sp = Math.sin(cam.lookPitch);
    const { fwd: f, up: u, right: r } = cam;
    const v = cam.view;
    for (let c = 0; c < 3; c++) {
      const h = cy * f[c] + sy * r[c];
      v.fwd[c] = cp * h + sp * u[c];
      v.up[c] = cp * u[c] - sp * h;
      v.right[c] = cy * r[c] - sy * f[c];
    }
  }

  const cam = {
    /** Drag look-around, radians on top of the path's heading (+yaw toward `right`, +pitch up). */
    lookYaw: 0,
    lookPitch: 0,
    /** The view basis with the look-around applied: what the shader gets. */
    view: { fwd: new Float64Array(3), up: new Float64Array(3), right: new Float64Array(3) },
    /**
     * The path point `dist` cells ahead (up to about 3), into `out`.
     * @param {number} dist @param {Float64Array} out
     */
    ahead(dist, out) {
      return ahead(dist, out);
    },
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      if (e.kind === "down") {
        dragging = true;
        x0 = e.x;
        y0 = e.y;
        yaw0 = cam.lookYaw;
        pitch0 = cam.lookPitch;
        vYaw = 0;
        vPitch = 0;
      } else if (e.kind === "move" && dragging) {
        cam.lookYaw = yaw0 - (e.x - x0) * LOOK_RATE;
        const p = pitch0 + (e.y - y0) * LOOK_RATE;
        cam.lookPitch = p > LOOK_PITCH ? LOOK_PITCH : p < -LOOK_PITCH ? -LOOK_PITCH : p;
      } else if (e.kind === "up") {
        dragging = false;
      }
    },
    /** The path's view basis (unit, orthogonal): forward, up, right. */
    fwd: new Float64Array([0, 0, 1]),
    up: new Float64Array([0, 1, 0]),
    right: new Float64Array([-1, 0, 0]),
    /** Camera position, cells (float64: it flies forever). */
    pos: new Float64Array(3),
    /**
     * Fly on by `speed × dt` cells along the path.
     * @param {number} dt seconds @param {number} speed cells per second
     */
    update(dt, speed) {
      let left = Math.max(0, speed * dt);
      while (left > 0) {
        const ds = Math.min(MAX_STEP, left);
        left -= ds;
        evaluate(0, u, cam.pos, tan);
        u += ds / Math.max(1e-6, Math.hypot(tan[0], tan[1], tan[2]));
        while (u >= 1) {
          u -= 1;
          // Drop the oldest point; walk one further.
          const last = (first + RING - 1) % RING;
          walk(last, first);
          first = (first + 1) % RING;
        }
      }
      evaluate(0, u, cam.pos, tan);
      orient();
      if (!dragging) {
        settle(cam.lookYaw, vYaw, dt);
        cam.lookYaw = spring[0];
        vYaw = spring[1];
        settle(cam.lookPitch, vPitch, dt);
        cam.lookPitch = spring[0];
        vPitch = spring[1];
      }
      look();
    },
  };
  evaluate(0, u, cam.pos, tan);
  orient();
  look();
  return cam;
}
