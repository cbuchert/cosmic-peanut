// @ts-check
/**
 * The sponge's camera provider (lib/structure-sponge.js): an endless zoom into ever-smaller
 * tunnels of the Menger sponge, built on lib/lattice-camera.js's smoothness recipe.
 *
 * Path: a uniform cubic B-spline over control points that come in dives of five. A dive starts on
 * the axis of M's central z tunnel (frame cells; M = [0, 9]³, its tunnels 3 wide) and ends on the
 * axis of a tunnel one third the size, in the wall sub-cube (1, 0, 1), as the zoom map
 * S(p) = F + (p − F)/3 of the next dive's start. Two dives, both checked against the sponge
 * (≥ 0.45 cell, in the frame's own units, all the way):
 * - SWERVE: on through the window where M's x tunnel crosses, sideways into the parallel z tunnel
 *   at x = 7.5 (the next dive runs on in the same direction);
 * - TURN: up the central tunnel and a quarter turn into the sub-cube's x tunnel at z = 7.5 (the
 *   next dive is the first reflected across x − 9 = z − 9, a symmetry of the world about F).
 * The world is symmetric under those reflections, so the dives compose without end: each new dive
 * is the canonical one under the accumulated reflection, scaled by 3^−k about F.
 *
 * Turns are decided on the beat: the choice is made when a dive's fourth point (the first that
 * differs) is appended to the ring, about four points ahead — beyond everything the camera is on
 * or looking at. With a beat since the last choice it turns with probability TURN_P (seeded);
 * otherwise, and always in silence, it swerves.
 *
 * Scale: every control point carries a local scale ℓ (3^−j/5 for the dive's j-th point, ×3^−k
 * for later dives), splined like the positions, so `scale` (frame cells per local cell) shrinks
 * smoothly by 3 over a dive. Speeds and look-ahead distances are local cells, so the zoom feels
 * steady. Rebase: when the camera enters a dive's first segment, every point is mapped by S⁻¹
 * (×3 about F), the scales by ×3, and `depth` counts up. It is a pure scaling, so the flight and
 * the view are continuous and positions stay within a few cells of F.
 *
 * Motion: lib/lattice-camera.js's — two critically damped speed stages (rate 5/s), a critically
 * damped angular view spring (6/s) toward the point LOOK_AHEAD local cells on, a bank into turns,
 * `up` carried by parallel transport, substeps of ≤ 1/240 s, and the drag look-around that eases
 * back on release. Nothing is allocated per update.
 */
import { prng } from "./tiedye.js";
import { SPONGE_F } from "./structure-sponge.js";

/** Control points kept: the current segment uses the first four, the rest serve look-ahead. */
const RING = 10;
/** Points per dive, the local scale's step per point, and frame cells per local cell at ℓ = 1. */
const DIVE = 5;
const L_STEP = 3 ** (-1 / DIVE);
const SCALE0 = 2;
/** Chance a dive turns when a beat has asked. */
const TURN_P = 0.6;
/** The camera's plane (y) and the dives' points in it: (x, z), frame cells. */
const PLANE = 4.5;
const START = [
  [4.5, 0],
  [4.5, 1.5],
  [4.5, 3],
];
const SWERVE = [
  [4.5, 4],
  [7.5, 5],
];
const TURN = [
  [4.5, 5.2],
  [4.5, 7.5],
];
/** The view looks at the path this many local cells ahead. */
export const LOOK_AHEAD = 1.2;
const AHEAD_STEPS = 24;
export const LOOK_RATE = 0.004;
export const LOOK_PITCH = 1.1;
const RETURN = 2.5;
const H = 1 / 240;
const SPEED_RATE = 5;
const VIEW_RATE = 6;
const BANK = 0.12;
const BANK_MAX = 0.18;

/** Uniform cubic B-spline basis at u and its derivative, into `w` (8 floats). */
function basis(/** @type {number} */ u, /** @type {Float64Array} */ w) {
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

/** @type {[number, number]} */
const spring = [0, 0];
/** One exact critically damped step toward 0 from (x, v) over dt, into `spring`. */
function settle(/** @type {number} */ x, /** @type {number} */ v, /** @type {number} */ dt) {
  const b = v + RETURN * x;
  const e = Math.exp(-RETURN * dt);
  spring[0] = (x + b * dt) * e;
  spring[1] = (b - RETURN * (x + b * dt)) * e;
}

/** @param {number} seed */
export function createSpongeCamera(seed) {
  const rand = prng(seed);
  /** Control points x y z ℓ, oldest first (a ring starting at `first`), and each one's index in its dive. */
  const pts = new Float64Array(RING * 4);
  const idx = new Int8Array(RING);
  let first = 0;
  // The dive being generated: its reflection (a 2 × 2 matrix on (x − 9, z − 9)), its scale
  // exponent relative to this frame, the next point's index and the option chosen.
  let t00 = 1;
  let t01 = 0;
  let t10 = 0;
  let t11 = 1;
  let genK = 0;
  let genJ = 0;
  let turning = false;
  let asked = false;
  const w = new Float64Array(8);
  let u = 0;

  /** Append the next dive point into ring slot `slot`. */
  function walk(/** @type {number} */ slot) {
    if (genJ === 3) {
      turning = asked && rand() < TURN_P;
      if (turning) cam.beatTurns++;
      else cam.idleTurns++;
      asked = false;
    }
    const c = genJ < 3 ? START[genJ] : (turning ? TURN : SWERVE)[genJ - 3];
    const f = 3 ** -genK;
    const a = c[0] - SPONGE_F[0];
    const b = c[1] - SPONGE_F[2];
    pts[slot * 4] = SPONGE_F[0] + f * (t00 * a + t01 * b);
    pts[slot * 4 + 1] = PLANE;
    pts[slot * 4 + 2] = SPONGE_F[2] + f * (t10 * a + t11 * b);
    pts[slot * 4 + 3] = f * L_STEP ** genJ;
    idx[slot] = genJ;
    if (++genJ === DIVE) {
      genJ = 0;
      genK++;
      if (turning) {
        // The next dive is reflected across x − 9 = z − 9 (columns swapped).
        const s0 = t00;
        const s1 = t10;
        t00 = t01;
        t10 = t11;
        t01 = s0;
        t11 = s1;
      }
    }
  }

  /** Map everything one frame down: ×3 about F. */
  function rebase() {
    for (let i = 0; i < RING; i++) {
      for (let c = 0; c < 3; c++) pts[i * 4 + c] = SPONGE_F[c] + 3 * (pts[i * 4 + c] - SPONGE_F[c]);
      pts[i * 4 + 3] *= 3;
    }
    genK--;
    cam.depth++;
  }

  /**
   * Segment `seg` (0 = current) at `t`: position into `out`, derivative into `tan`; returns ℓ.
   * @param {number} seg @param {number} t @param {Float64Array} out @param {Float64Array} tan
   */
  function evaluate(seg, t, out, tan) {
    basis(t, w);
    let l = 0;
    for (let c = 0; c < 4; c++) {
      let p = 0;
      let d = 0;
      for (let k = 0; k < 4; k++) {
        const v = pts[((first + seg + k) % RING) * 4 + c];
        p += w[k] * v;
        d += w[4 + k] * v;
      }
      if (c < 3) {
        out[c] = p;
        tan[c] = d;
      } else l = p;
    }
    return l;
  }

  const tan = new Float64Array(3);
  const tmp = new Float64Array(3);
  const tmpTan = new Float64Array(3);

  /** The path point `dist` local cells ahead, into `out` (midpoint steps by arc length). */
  function ahead(/** @type {number} */ dist, /** @type {Float64Array} */ out) {
    let seg = 0;
    let t = u;
    const ds = dist / AHEAD_STEPS;
    for (let i = 0; i < AHEAD_STEPS; i++) {
      let l = evaluate(seg, t, tmp, tmpTan);
      const half = t + (0.5 * ds * l * SCALE0) / Math.max(1e-9, Math.hypot(tmpTan[0], tmpTan[1], tmpTan[2]));
      l = evaluate(seg, Math.min(half, 1), tmp, tmpTan);
      t += (ds * l * SCALE0) / Math.max(1e-9, Math.hypot(tmpTan[0], tmpTan[1], tmpTan[2]));
      while (t >= 1 && seg < RING - 4) {
        t -= 1;
        seg++;
      }
    }
    evaluate(seg, Math.min(t, 1), out, tmpTan);
    return out;
  }

  /** Move `ds` local cells along the path. */
  function advance(/** @type {number} */ ds) {
    let l = evaluate(0, u, tmp, tan);
    const half = Math.min(1, u + (0.5 * ds * l * SCALE0) / Math.max(1e-9, Math.hypot(tan[0], tan[1], tan[2])));
    l = evaluate(0, half, tmp, tan);
    u += (ds * l * SCALE0) / Math.max(1e-9, Math.hypot(tan[0], tan[1], tan[2]));
    while (u >= 1) {
      u -= 1;
      walk(first);
      first = (first + 1) % RING;
      // Entered a dive's first segment: into the next frame.
      if (idx[(first + 1) % RING] === 0) rebase();
    }
    cam.scale = evaluate(0, u, cam.pos, tan) * SCALE0;
  }

  const target = new Float64Array(3);
  const desired = new Float64Array(3);
  const omega = new Float64Array(3);
  let speed = Number.NaN;
  let speedMid = 0;
  let accel = 0;
  let accelMid = 0;
  let roll = 0;

  function lookDirection() {
    ahead(LOOK_AHEAD, target);
    for (let c = 0; c < 3; c++) desired[c] = target[c] - cam.pos[c];
    const l = Math.hypot(desired[0], desired[1], desired[2]);
    for (let c = 0; c < 3; c++) desired[c] /= l;
  }

  /** Turn the view toward `desired` through the angular spring over h, carrying `up` along. */
  function turnView(/** @type {number} */ h) {
    const f = cam.fwd;
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
    const up = cam.up;
    const du = up[0] * f[0] + up[1] * f[1] + up[2] * f[2];
    for (let c = 0; c < 3; c++) up[c] -= du * f[c];
    const ul = Math.hypot(up[0], up[1], up[2]);
    for (let c = 0; c < 3; c++) up[c] /= ul;
    const r = cam.right;
    r[0] = f[1] * up[2] - f[2] * up[1];
    r[1] = f[2] * up[0] - f[0] * up[2];
    r[2] = f[0] * up[1] - f[1] * up[0];
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
    /** Dives that turned because a beat asked, and that swerved straight on. */
    beatTurns: 0,
    idleTurns: 0,
    /** Rebases so far: the zoom depth (each one is ×3). */
    depth: 0,
    /** Frame cells per local cell at the camera (shrinks by 3 over a dive, ×3 at each rebase). */
    scale: SCALE0,
    lookYaw: 0,
    lookPitch: 0,
    view: { fwd: new Float64Array(3), up: new Float64Array(3), right: new Float64Array(3) },
    beat() {
      asked = true;
    },
    /** The path point `dist` local cells ahead (up to about 3), into `out`. */
    ahead(/** @type {number} */ dist, /** @type {Float64Array} */ out) {
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
    fwd: new Float64Array([0, 0, 1]),
    up: new Float64Array([0, 1, 0]),
    right: new Float64Array([-1, 0, 0]),
    /** Camera position, frame cells (within a few cells of F however deep the zoom). */
    pos: new Float64Array(3),
    /**
     * Fly on for `dt` seconds, smoothly approaching `targetSpeed` local cells per second.
     * @param {number} dt @param {number} targetSpeed
     */
    update(dt, targetSpeed) {
      const goal = Math.max(0, targetSpeed);
      if (Number.isNaN(speed)) speed = speedMid = goal;
      const n = Math.max(1, Math.ceil(dt / H - 1e-9));
      const h = dt / n;
      const k = SPEED_RATE * SPEED_RATE;
      const c = 2 * SPEED_RATE;
      for (let i = 0; i < n; i++) {
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

  for (let i = 0; i < RING; i++) walk(i);
  cam.scale = evaluate(0, u, cam.pos, tan) * SCALE0;
  lookDirection();
  cam.fwd.set(desired);
  turnView(0);
  look();
  return cam;
}
