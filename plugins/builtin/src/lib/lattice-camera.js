// @ts-check
/**
 * Lattice's camera — the cubic structure's camera path provider: flies forward through the empty
 * channels of the cubic lattice, smoothly.
 *
 * World units are cells: nodes sit at integer points and struts run along the axes between them,
 * so the cell centres (all three coordinates half-integers) are the points farthest from any
 * geometry and the lines through them, parallel to an axis, are free channels.
 *
 * Path: a walk from cell centre to adjacent cell centre, smoothed by a uniform cubic B-spline over
 * those points (C2: no jerk from the path), which passes within 1/6 cell of each control point and
 * cuts each corner by under 0.25 cell, so it stays ≥ 0.47 cell from every strut axis. Turns are
 * decided on the beat: `beat()` asks for one, and the next control point appended — about four
 * cells ahead, beyond everything the camera is on or looking at (a B-spline segment depends only
 * on its four points) — turns to one of the four perpendicular axes once the run is long enough
 * (a seeded 2–5 cells). So the beat picks the next turn; it never moves the current one. In
 * silence it turns every RUN_IDLE cells.
 *
 * Motion: the speed asked for goes through two critically damped stages, so a beat surge is a
 * smooth push (continuous acceleration and jerk), and the camera moves along the path by arc
 * length. The view turns toward the path point LOOK_AHEAD cells on through a critically damped
 * angular spring (turns are seen coming, and a surge never whips the view), banks a little into
 * turns, and carries `up` by parallel transport (never degenerate when the path climbs straight
 * up). Everything is integrated in substeps of at most 1/240 s, so frame hitches change nothing
 * but how often it's drawn. Dragging turns the view about that heading (the scene follows the
 * pointer); on release a critically damped spring eases it back, Möbius Field's `fly.js` rule.
 *
 * Nothing is allocated per update.
 */
import { prng } from "./tiedye.js";

/** Control points kept: the current segment uses the first four, the rest serve look-ahead. */
const RING = 8;
/** A turn may come once a run is this long (seeded per run), and comes anyway after RUN_IDLE. */
const RUN_MIN = 2;
const RUN_MAX = 5;
export const RUN_IDLE = 8;
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
/** Longest substep (s): motion is integrated in steps this short whatever the frame time. */
const H = 1 / 240;
/** Speed smoothing: two critically damped stages at this rate (1/s). */
const SPEED_RATE = 5;
/** View turning: a critically damped angular spring at this rate (1/s). */
const VIEW_RATE = 6;
/** Bank into turns: radians of roll per rad/s of yaw, at most BANK_MAX. */
const BANK = 0.12;
const BANK_MAX = 0.18;

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
  let run = 0; // cells since the last turn
  let runTarget = RUN_IDLE; // the first stretch runs straight
  let asked = false; // a beat asked for a turn since the last point was appended
  const w = new Float64Array(8);
  /** The current segment (between control points 1 and 2 of the ring) and the place along it. */
  let u = 0;

  /** Append the next walk point after point `prev` (ring index) into ring slot `slot`. */
  function walk(/** @type {number} */ prev, /** @type {number} */ slot) {
    run++;
    const onBeat = asked && run >= runTarget;
    if (onBeat || run >= RUN_IDLE) {
      if (onBeat) cam.beatTurns++;
      else cam.idleTurns++;
      const axis = dir >> 1;
      // One of the four directions on the other two axes.
      const k = Math.floor(rand() * 4);
      const other = (axis + 1 + (k >> 1)) % 3;
      dir = other * 2 + (k & 1);
      run = 0;
      runTarget = RUN_MIN + Math.floor(rand() * (RUN_MAX - RUN_MIN + 1));
    }
    asked = false;
    const d = DIRS[dir];
    for (let c = 0; c < 3; c++) pts[slot * 3 + c] = pts[prev * 3 + c] + d[c];
  }

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

  /** Move `ds` cells along the path (a midpoint step in the spline parameter). */
  function advance(/** @type {number} */ ds) {
    evaluate(0, u, tmp, tan);
    const half = Math.min(1, u + (0.5 * ds) / Math.max(1e-6, Math.hypot(tan[0], tan[1], tan[2])));
    evaluate(0, half, tmp, tan);
    u += ds / Math.max(1e-6, Math.hypot(tan[0], tan[1], tan[2]));
    while (u >= 1) {
      u -= 1;
      // Drop the oldest point; walk one further.
      const last = (first + RING - 1) % RING;
      walk(last, first);
      first = (first + 1) % RING;
    }
    evaluate(0, u, cam.pos, tan);
  }

  const target = new Float64Array(3);
  const desired = new Float64Array(3);
  /** The view's angular velocity (rad/s, as a world rotation vector). */
  const omega = new Float64Array(3);
  let speed = Number.NaN; // after both smoothing stages
  let speedMid = 0;
  let accel = 0; // d speed / dt
  let accelMid = 0;
  let roll = 0;

  /** The unit direction from the camera to the look-ahead point, into `desired`. */
  function lookDirection() {
    ahead(LOOK_AHEAD, target);
    for (let c = 0; c < 3; c++) desired[c] = target[c] - cam.pos[c];
    const l = Math.hypot(desired[0], desired[1], desired[2]);
    for (let c = 0; c < 3; c++) desired[c] /= l;
  }

  /** Turn the view toward `desired` through the angular spring over h, carrying `up` along. */
  function turnView(/** @type {number} */ h) {
    const f = cam.fwd;
    // Error: the rotation taking f to `desired`, as a rotation vector.
    let ex = f[1] * desired[2] - f[2] * desired[1];
    let ey = f[2] * desired[0] - f[0] * desired[2];
    let ez = f[0] * desired[1] - f[1] * desired[0];
    const s = Math.hypot(ex, ey, ez);
    const ang = Math.atan2(s, f[0] * desired[0] + f[1] * desired[1] + f[2] * desired[2]);
    const k = s > 1e-12 ? ang / s : 1;
    ex *= k;
    ey *= k;
    ez *= k;
    const kk = VIEW_RATE * VIEW_RATE;
    const cc = 2 * VIEW_RATE;
    omega[0] += (kk * ex - cc * omega[0]) * h;
    omega[1] += (kk * ey - cc * omega[1]) * h;
    omega[2] += (kk * ez - cc * omega[2]) * h;
    // Rotate f by omega × h (Rodrigues), then renormalize.
    const ax = omega[0] * h;
    const ay = omega[1] * h;
    const az = omega[2] * h;
    const th = Math.hypot(ax, ay, az);
    if (th > 1e-12) {
      const nx = ax / th;
      const ny = ay / th;
      const nz = az / th;
      const co = Math.cos(th);
      const si = Math.sin(th);
      const d = nx * f[0] + ny * f[1] + nz * f[2];
      const cx = ny * f[2] - nz * f[1];
      const cy = nz * f[0] - nx * f[2];
      const cz = nx * f[1] - ny * f[0];
      const f0 = f[0] * co + cx * si + nx * d * (1 - co);
      const f1 = f[1] * co + cy * si + ny * d * (1 - co);
      const f2 = f[2] * co + cz * si + nz * d * (1 - co);
      f[0] = f0;
      f[1] = f1;
      f[2] = f2;
    }
    const fl = Math.hypot(f[0], f[1], f[2]);
    for (let c = 0; c < 3; c++) f[c] /= fl;
    // Parallel transport of up, then the right-handed basis.
    const up = cam.up;
    const du = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
    for (let c = 0; c < 3; c++) up[c] -= du * f[c];
    const ul = Math.hypot(up[0], up[1], up[2]);
    for (let c = 0; c < 3; c++) up[c] /= ul;
    const r = cam.right;
    r[0] = f[1] * up[2] - f[2] * up[1];
    r[1] = f[2] * up[0] - f[0] * up[2];
    r[2] = f[0] * up[1] - f[1] * up[0];
    // Bank: roll with the yaw rate, within BANK_MAX (omega is smooth, so the roll is too).
    const yaw = omega[0] * up[0] + omega[1] * up[1] + omega[2] * up[2];
    roll = Math.max(-BANK_MAX, Math.min(BANK_MAX, BANK * yaw));
  }

  let dragging = false;
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  let vYaw = 0;
  let vPitch = 0;

  /** The view basis, banked, then turned by the look-around, into `cam.view`. */
  function look() {
    const cb = Math.cos(roll);
    const sb = Math.sin(roll);
    const cy = Math.cos(cam.lookYaw);
    const sy = Math.sin(cam.lookYaw);
    const cp = Math.cos(cam.lookPitch);
    const sp = Math.sin(cam.lookPitch);
    const { fwd: f, up: u0, right: r0 } = cam;
    const v = cam.view;
    for (let c = 0; c < 3; c++) {
      const uc = cb * u0[c] + sb * r0[c];
      const rc = cb * r0[c] - sb * u0[c];
      const h = cy * f[c] + sy * rc;
      v.fwd[c] = cp * h + sp * uc;
      v.up[c] = cp * uc - sp * h;
      v.right[c] = cy * rc - sy * f[c];
    }
  }

  const cam = {
    /** Turns taken because a beat asked, and in silence (after RUN_IDLE cells). */
    beatTurns: 0,
    idleTurns: 0,
    /** Drag look-around, radians on top of the path's heading (+yaw toward `right`, +pitch up). */
    lookYaw: 0,
    lookPitch: 0,
    /** The view basis with the bank and the look-around applied: what the shader gets. */
    view: { fwd: new Float64Array(3), up: new Float64Array(3), right: new Float64Array(3) },
    /** A beat: the next control point appended may turn (if the run is long enough). */
    beat() {
      asked = true;
    },
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
    /** The view's own basis (unit, orthogonal; unbanked): forward, up, right. */
    fwd: new Float64Array([0, 0, 1]),
    up: new Float64Array([0, 1, 0]),
    right: new Float64Array([-1, 0, 0]),
    /** Camera position, cells (float64: it flies forever). */
    pos: new Float64Array(3),
    /**
     * Fly on for `dt` seconds, smoothly approaching `targetSpeed` cells per second.
     * @param {number} dt seconds @param {number} targetSpeed cells per second
     */
    update(dt, targetSpeed) {
      const goal = Math.max(0, targetSpeed);
      if (Number.isNaN(speed)) speed = speedMid = goal;
      const n = Math.max(1, Math.ceil(dt / H - 1e-9));
      const h = dt / n;
      const k = SPEED_RATE * SPEED_RATE;
      const c = 2 * SPEED_RATE;
      for (let i = 0; i < n; i++) {
        // Two critically damped stages: goal → speedMid → speed.
        accelMid += (k * (goal - speedMid) - c * accelMid) * h;
        speedMid += accelMid * h;
        accel += (k * (speedMid - speed) - c * accel) * h;
        speed += accel * h;
        advance(Math.max(0, speed) * h);
        lookDirection();
        turnView(h);
      }
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

  // Start in a channel, the first points straight ahead.
  for (let c = 0; c < 3; c++) pts[c] = 0.5;
  for (let i = 1; i < RING; i++) walk(i - 1, i);
  evaluate(0, u, cam.pos, tan);
  lookDirection();
  cam.fwd.set(desired);
  turnView(0);
  look();
  return cam;
}
