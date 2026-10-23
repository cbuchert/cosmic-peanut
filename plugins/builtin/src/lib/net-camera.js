// @ts-check
/**
 * A camera path provider for structures whose free space has a periodic skeletal graph (a net):
 * the TPMS labyrinths (lib/tpms.js: the srs net of the gyroid, the cubic net of Schwarz P, the
 * diamond net of Schwarz D). It is lib/lattice-camera.js's flight with the walk generalized from
 * "cell centre to cell centre" to "net node to net node".
 *
 * Path: a walk along the net's edges (each split into `sub` equal steps, so a long straight edge
 * through a neck stays straight), smoothed by a uniform cubic B-spline over those points. The
 * nets' nodes sit at the level function's maxima, the middle of the labyrinth, and its edges run
 * down the tunnels; tpmsClearance bounds how close the smoothed path comes to the worst-case walls.
 *
 * Heading: the walk prefers one axis direction (and, to break ties on the nets whose edges are
 * diagonal, a little of a second one). At each node it takes the edge, other than the one it came
 * along, that best follows that preference, so on the srs and diamond nets it coils and zigzags
 * along the axis through the helical and staggered tunnels. A heading change is decided on the
 * beat: `beat()` asks, and the next node decision appended — a few cells ahead, beyond what the
 * camera is on or looking at (a B-spline segment depends only on its four points) — turns the
 * preference to one of the four perpendicular axes once the run is long enough (a seeded 3–8
 * cells). In silence it turns after RUN_IDLE cells.
 *
 * Motion, view, bank, look-around and substeps are lattice-camera.js's (the README's smoothness
 * recipe): two critically damped speed stages, a critically damped angular spring toward the path
 * LOOK_AHEAD cells on, parallel-transported `up`, substeps of at most 1/240 s.
 *
 * Nothing is allocated per update.
 */
import { LOOK_AHEAD, LOOK_PITCH, LOOK_RATE } from "./lattice-camera.js";
import { prng } from "./tiedye.js";

/** A heading change may come once a run is this long (cells, seeded per run), and comes anyway after RUN_IDLE. */
const RUN_MIN = 3;
const RUN_MAX = 8;
export const RUN_IDLE = 14;
/** Weight of the secondary direction in the edge choice. */
const SECOND = 0.35;
/** Substeps of the look-ahead march. */
const AHEAD_STEPS = 24;
/** The release spring's rate (1/s). */
const RETURN = 2.5;
/** Longest substep (s). */
const H = 1 / 240;
/** Speed smoothing: two critically damped stages at this rate (1/s). */
const SPEED_RATE = 5;
/** View turning: a critically damped angular spring at this rate (1/s). */
const VIEW_RATE = 6;
/** Bank into turns: radians of roll per rad/s of yaw, at most BANK_MAX. */
const BANK = 0.12;
const BANK_MAX = 0.18;
/** Cells ahead where a new control point first bends the path (sets the ring size). */
const DECIDE_AHEAD = 4;

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
 * @typedef {object} Net
 * @property {number} period cells
 * @property {number[][]} nodes node positions in one period, in eighths of it
 * @property {number} sub control points per edge
 */

/**
 * Each node's edges: [dx, dy, dz (cells), the node index at the far end], to its nearest
 * neighbours among all periodic images.
 * @param {Net} net
 */
export function netEdges(net) {
  const a = net.period;
  const pos = net.nodes.map((n) => n.map((v) => (v * a) / 8));
  /** @type {number[][][]} */
  const out = [];
  let best = Infinity;
  /** @type {(i: number, f: (d: number[], j: number) => void) => void} */
  const near = (i, f) => {
    for (let j = 0; j < pos.length; j++)
      for (let x = -1; x <= 1; x++)
        for (let y = -1; y <= 1; y++)
          for (let z = -1; z <= 1; z++) {
            const d = [pos[j][0] + x * a - pos[i][0], pos[j][1] + y * a - pos[i][1], pos[j][2] + z * a - pos[i][2]];
            if (Math.hypot(d[0], d[1], d[2]) > 1e-9) f(d, j);
          }
  };
  near(0, (d) => (best = Math.min(best, Math.hypot(d[0], d[1], d[2]))));
  for (let i = 0; i < pos.length; i++) {
    /** @type {number[][]} */
    const list = [];
    near(i, (d, j) => {
      if (Math.hypot(d[0], d[1], d[2]) < best * 1.01) list.push([d[0], d[1], d[2], j]);
    });
    out.push(list);
  }
  return out;
}

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

/**
 * @param {Net} net @param {number} seed
 */
export function createNetCamera(net, seed) {
  const rand = prng(seed);
  const edges = netEdges(net);
  const sub = Math.max(1, Math.round(net.sub));
  const e0 = edges[0][0];
  const edgeLen = Math.hypot(e0[0], e0[1], e0[2]);
  /** Control points kept: the current segment uses the first four, the rest serve look-ahead. */
  const RING = 4 + Math.max(2, Math.round(DECIDE_AHEAD / (edgeLen / sub)));
  const pts = new Float64Array(RING * 3);
  let first = 0;
  // The walk: the current edge (from node `at`, its start position and vector) and the step on it.
  let node = 0;
  const from = new Float64Array(3);
  const edge = new Float64Array(3);
  let step = sub; // a whole edge walked: decide the next one first
  let dir = 4; // preferred heading +z...
  let second = 0; // ...with a little +x
  let run = 0; // cells since the last heading change
  let runTarget = RUN_IDLE; // the first stretch keeps its heading
  let asked = false; // a beat asked for a heading change since the last decision
  const w = new Float64Array(8);
  let u = 0;

  /** At a node: maybe change heading, then take the edge that best follows it. */
  function decide() {
    const onBeat = asked && run >= runTarget;
    if (onBeat || run >= RUN_IDLE) {
      if (onBeat) cam.beatTurns++;
      else cam.idleTurns++;
      const axis = dir >> 1;
      const k = Math.floor(rand() * 4);
      const other = (axis + 1 + (k >> 1)) % 3;
      dir = other * 2 + (k & 1);
      // The secondary direction: either way along the remaining axis.
      second = (3 - axis - other) * 2 + (rand() < 0.5 ? 0 : 1);
      run = 0;
      runTarget = RUN_MIN + rand() * (RUN_MAX - RUN_MIN);
    }
    asked = false;
    const d = DIRS[dir];
    const s2 = DIRS[second];
    const list = edges[node];
    let pick = -1;
    let score = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // Never straight back along the edge just walked.
      if (e[0] * edge[0] + e[1] * edge[1] + e[2] * edge[2] < -0.999 * edgeLen * edgeLen) continue;
      const sc = (e[0] * (d[0] + SECOND * s2[0]) + e[1] * (d[1] + SECOND * s2[1]) + e[2] * (d[2] + SECOND * s2[2])) / edgeLen;
      if (sc > score + 1e-9) {
        score = sc;
        pick = i;
      }
    }
    const e = list[pick];
    for (let c = 0; c < 3; c++) {
      from[c] += edge[c];
      edge[c] = e[c];
    }
    node = e[3];
    step = 0;
    run += edgeLen;
  }

  /** Append the next walk point into ring slot `slot`. */
  function walk(/** @type {number} */ slot) {
    if (step >= sub) decide();
    step++;
    for (let c = 0; c < 3; c++) pts[slot * 3 + c] = from[c] + (edge[c] * step) / sub;
  }

  /**
   * Evaluate segment `seg` (0 = the current one) at `t` into `out` and `tan`.
   * @param {number} seg @param {number} t @param {Float64Array} out @param {Float64Array} tan
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

  /** The path point `dist` cells ahead of the camera, into `out`. */
  function ahead(/** @type {number} */ dist, /** @type {Float64Array} */ out) {
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

  /** Move `ds` cells along the path. */
  function advance(/** @type {number} */ ds) {
    evaluate(0, u, tmp, tan);
    const half = Math.min(1, u + (0.5 * ds) / Math.max(1e-6, Math.hypot(tan[0], tan[1], tan[2])));
    evaluate(0, half, tmp, tan);
    u += ds / Math.max(1e-6, Math.hypot(tan[0], tan[1], tan[2]));
    while (u >= 1) {
      u -= 1;
      walk(first);
      first = (first + 1) % RING;
    }
    evaluate(0, u, cam.pos, tan);
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
    /** Heading changes taken because a beat asked, and in silence (after RUN_IDLE cells). */
    beatTurns: 0,
    idleTurns: 0,
    lookYaw: 0,
    lookPitch: 0,
    view: { fwd: new Float64Array(3), up: new Float64Array(3), right: new Float64Array(3) },
    /** A beat: the next node decision may change heading (if the run is long enough). */
    beat() {
      asked = true;
    },
    /** @param {number} dist @param {Float64Array} out */
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
    fwd: new Float64Array([0, 0, 1]),
    up: new Float64Array([0, 1, 0]),
    right: new Float64Array([-1, 0, 0]),
    pos: new Float64Array(3),
    /** @param {number} dt seconds @param {number} targetSpeed cells per second */
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

  // Start on node 0 (the edge "walked" so far is empty), the first stretch along +z.
  const n0 = net.nodes[0];
  for (let c = 0; c < 3; c++) from[c] = (n0[c] * net.period) / 8;
  for (let c = 0; c < 3; c++) pts[c] = from[c];
  for (let i = 1; i < RING; i++) walk(i);
  evaluate(0, u, cam.pos, tan);
  lookDirection();
  cam.fwd.set(desired);
  // A right-handed start basis with forward along the path.
  const f = cam.fwd;
  const upGuess = Math.abs(f[1]) < 0.9 ? DIRS[2] : DIRS[0];
  const dd = upGuess[0] * f[0] + upGuess[1] * f[1] + upGuess[2] * f[2];
  for (let c = 0; c < 3; c++) cam.up[c] = upGuess[c] - dd * f[c];
  turnView(0);
  look();
  return cam;
}
