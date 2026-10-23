// @ts-check
/**
 * Tiled Sphere's view: where the camera is (outside, inside, or pushing through the surface on
 * phrase changes), drag to orbit or look around with an eased return, the sphere's turn, and the
 * param mapping onto the shared tess state. Everything steps in place; nothing allocates per frame.
 */
import { classColors, smooth } from "./tess-music.js";

/** View param options. */
export const VIEWS = ["outside", "inside", "auto"];
/** @param {unknown} v → a view, "auto" if unknown */
export const viewName = (v) => (VIEWS.includes(String(v)) ? String(v) : "auto");

/** Seconds a push through the surface (or back out) takes, and Reduce motion's multiple. */
export const TRANSIT = 6;
export const REDUCED_TRANSIT = 2;
/** Auto: morph steps (bars with a tempo) per phrase; a move comes on a phrase change… */
export const PHRASE_STEPS = 8;
/** …at least this many seconds after the last move, or anyway after this many. */
export const MIN_DWELL = 12;
export const MAX_DWELL = 60;

/**
 * @typedef {object} PushInput
 * @property {string} view "outside" | "inside" | "auto"
 * @property {boolean} stepped the tess state's `stepped` (a morph step: a bar, or a strong onset)
 * @property {boolean} reduceMotion
 */

/**
 * The camera's push, 0 outside … 1 inside. Starts where the view says; a change of view (or, in
 * auto, a phrase change) eases there with a smoothstep over TRANSIT seconds from wherever it is.
 */
export function createPush() {
  let started = false;
  let from = 0;
  let u = 1;
  let dwell = 0;
  let steps = 0;
  const p = {
    value: 0,
    /** Where it is heading: 0 or 1. */
    target: 0,
    /** @param {number} dt @param {PushInput} o */
    step(dt, o) {
      if (!started) {
        started = true;
        p.target = p.value = o.view === "inside" ? 1 : 0;
        return p;
      }
      dwell += dt;
      let want = p.target;
      if (o.view === "inside") want = 1;
      else if (o.view === "outside") want = 0;
      else {
        if (o.stepped) steps++;
        const settled = u >= 1;
        if (settled && ((o.stepped && steps % PHRASE_STEPS === 0 && dwell >= MIN_DWELL) || dwell >= MAX_DWELL)) want = 1 - p.target;
      }
      if (want !== p.target) {
        p.target = want;
        from = p.value;
        u = 0;
        dwell = 0;
      }
      u = Math.min(1, u + dt / (TRANSIT * (o.reduceMotion ? REDUCED_TRANSIT : 1)));
      p.value = from + (p.target - from) * smooth(u);
      return p;
    },
  };
  return p;
}

/** Camera distance from the centre (sphere radius 1): outside and inside. */
export const D_OUT = 3.6;
export const D_IN = 0.35;
/** Vertical field of view (rad), outside and inside. */
const FOV_OUT = 0.75;
const FOV_IN = 1.45;
/** Within this distance of the surface the print fades into paper (the membrane you push through). */
const VEIL = 0.15;

/**
 * Camera for a push value.
 * @param {number} push 0–1
 * @param {{ dist: number, fov: number, veil: number, inside: number }} out inside = 1 once past the surface
 */
export function cameraAt(push, out) {
  out.dist = D_OUT * (1 - push) + D_IN * push;
  out.fov = FOV_OUT * (1 - push) + FOV_IN * push;
  out.veil = 1 - smooth(Math.abs(out.dist - 1) / VEIL);
  out.inside = out.dist < 1 ? 1 : 0;
  return out;
}

/**
 * Eye and basis: the eye orbits the centre at `dist` (yaw about the vertical, pitch above the
 * equator) looking at it, then the view turns by the look angles (drag inside).
 * @param {number} dist @param {number} orbitYaw @param {number} orbitPitch
 * @param {number} lookYaw @param {number} lookPitch
 * @param {Float32Array} out eye, right, up, forward (3 floats each)
 */
export function cameraBasis(dist, orbitYaw, orbitPitch, lookYaw, lookPitch, out) {
  const cp = Math.cos(orbitPitch);
  // Towards the centre, with right horizontal and up = right × forward.
  const fx = -cp * Math.sin(orbitYaw);
  const fy = -Math.sin(orbitPitch);
  const fz = -cp * Math.cos(orbitYaw);
  const rl = Math.hypot(fz, fx) || 1;
  const rx = -fz / rl;
  const rz = fx / rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const cy = Math.cos(lookYaw);
  const sy = Math.sin(lookYaw);
  const cl = Math.cos(lookPitch);
  const sl = Math.sin(lookPitch);
  const gx = (fx * cy + rx * sy) * cl + ux * sl;
  const gy = fy * cy * cl + uy * sl;
  const gz = (fz * cy + rz * sy) * cl + uz * sl;
  // right' = forward' × up (normalised), up' = right' × forward'.
  let ax = gy * uz - gz * uy;
  let ay = gz * ux - gx * uz;
  let az = gx * uy - gy * ux;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;
  out[0] = -dist * fx;
  out[1] = -dist * fy;
  out[2] = -dist * fz;
  out[3] = ax;
  out[4] = ay;
  out[5] = az;
  out[6] = ay * gz - az * gy;
  out[7] = az * gx - ax * gz;
  out[8] = ax * gy - ay * gx;
  out[9] = gx;
  out[10] = gy;
  out[11] = gz;
  return out;
}

/** Drag: radians per CSS pixel, the pitch limit, and the return spring's rate (1/s). */
export const DRAG_RATE = 0.005;
export const PITCH_LIMIT = 1.2;
const RETURN = 2.2;
/** @param {number} x */
const clampPitch = (x) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, x));

/**
 * Drag offsets (yaw, pitch). While held they follow the pointer; on release a critically damped
 * spring brings them back to rest from zero speed: no jolt, no overshoot.
 */
export function createDrag() {
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  let vy = 0;
  let vp = 0;
  const d = {
    yaw: 0,
    pitch: 0,
    dragging: false,
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      if (e.kind === "down") {
        d.dragging = true;
        x0 = e.x;
        y0 = e.y;
        yaw0 = d.yaw;
        pitch0 = d.pitch;
      } else if (e.kind === "move" && d.dragging) {
        d.yaw = yaw0 + (e.x - x0) * DRAG_RATE;
        d.pitch = clampPitch(pitch0 - (e.y - y0) * DRAG_RATE);
      } else if (e.kind === "up") {
        d.dragging = false;
        vy = 0;
        vp = 0;
      }
    },
    /** @param {number} dt @param {boolean} reduceMotion eases back at half the rate */
    step(dt, reduceMotion) {
      if (d.dragging) return d;
      const w = RETURN * (reduceMotion ? 0.5 : 1);
      const e = Math.exp(-w * dt);
      // Exact critically damped step: x(t) = (x0 + (v0 + w x0) t) e^(−wt).
      const by = vy + w * d.yaw;
      const bp = vp + w * d.pitch;
      d.yaw = (d.yaw + by * dt) * e;
      vy = (vy - w * by * dt) * e;
      d.pitch = (d.pitch + bp * dt) * e;
      vp = (vp - w * bp * dt) * e;
      return d;
    },
  };
  return d;
}

/** The sphere's resting orientation: a little turned and tipped so no face meets the eye square on. */
const REST_X = 0.62;
const REST_Z = 0.35;

/**
 * World → sphere rotation (column-major mat3) for a spin about the vertical and a tilt of that
 * axis towards the viewer: sphere-to-world W = Rx(tilt) · Ry(spin) · Rz(REST_Z) · Rx(REST_X).
 * @param {number} spin @param {number} tilt @param {Float32Array} out
 */
export function sphereFrame(spin, tilt, out) {
  const ca = Math.cos(REST_X);
  const sa = Math.sin(REST_X);
  const cb = Math.cos(REST_Z);
  const sb = Math.sin(REST_Z);
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // M = Rz(b) · Rx(a)
  const m00 = cb;
  const m01 = -sb * ca;
  const m02 = sb * sa;
  const m10 = sb;
  const m11 = cb * ca;
  const m12 = -cb * sa;
  const m21 = sa;
  const m22 = ca;
  // Ry(spin) · M: rows 0 and 2 change (M row 2 is 0, sa, ca).
  const n00 = cs * m00;
  const n01 = cs * m01 + ss * m21;
  const n02 = cs * m02 + ss * m22;
  const n20 = -ss * m00;
  const n21 = -ss * m01 + cs * m21;
  const n22 = -ss * m02 + cs * m22;
  // W = Rx(tilt) · that, row-major; world → sphere is Wᵀ, whose column-major storage is W row-major.
  out[0] = n00;
  out[1] = n01;
  out[2] = n02;
  out[3] = ct * m10 - st * n20;
  out[4] = ct * m11 - st * n21;
  out[5] = ct * m12 - st * n22;
  out[6] = st * m10 + ct * n20;
  out[7] = st * m11 + ct * n21;
  out[8] = st * m12 + ct * n22;
  return out;
}

/**
 * @typedef {object} OptionsCtx
 * @property {Record<string, unknown>} params @property {{ height: number }} size
 * @property {boolean} reduceMotion @property {boolean} reduceFlashing
 */

/**
 * The params onto lib/tess-music.js TessOptions. Always p4: the cube's edges are quarter turns.
 * @param {OptionsCtx} ctx @param {import('./tess-music.js').TessOptions} o
 */
export function fillOptions(ctx, o) {
  const p = ctx.params;
  o.symmetry = "p4";
  o.palette = String(p.palette);
  o.reactivity = Number(p.reactivity);
  o.speed = Number(p.speed);
  o.morph = Number(p.morph);
  o.ink = Number(p.ink);
  o.hatching = Number(p.hatching);
  o.height = ctx.size.height;
  o.reduceMotion = ctx.reduceMotion;
  o.reduceFlashing = ctx.reduceFlashing;
  return o;
}

/**
 * Linear colours of three classes (the checkerboard's two plus the seams' third) now and after
 * the figure/ground shift under way, from a lib/tess.js paletteOf array with n ≥ 3 tile colours.
 * @param {Float32Array} pal @param {number} n @param {number} shift
 * @param {Float32Array} now @param {Float32Array} next length 9
 */
export function threeClassColors(pal, n, shift, now, next) {
  classColors(pal, n, 3, shift, now, next);
  for (let i = 0; i < 9; i++) {
    now[i] = Math.pow(now[i], 2.2);
    next[i] = Math.pow(next[i], 2.2);
  }
}
