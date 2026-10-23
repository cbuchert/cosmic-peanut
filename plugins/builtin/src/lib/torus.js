// @ts-check
/**
 * Tiled Torus: the mapping from the torus to the tiling plane, and the camera (outside orbit,
 * inside fly-through, the dive between them, drag). Pure functions and small stateful objects;
 * nothing here allocates per frame.
 *
 * The torus: major radius R = 1 about the y axis, tube radius r = k (the Thickness param).
 * θ = atan2(z, x) runs around the ring, φ around the tube (0 on the outer equator). The plane
 * point is p = (lx · (θ/2π + fu), ly · (t(φ) + fv)) with t the conformal fraction of the minor
 * circle (shaders/tess/torus.frag mirrors it): tiles are squares everywhere, larger on the outer
 * equator, and the tiling closes because lx and ly are periods of the warped, coloured tiling.
 */
import { BLEND_PERIOD } from "./tess-music.js";

const S3 = Math.sqrt(3);
/** Lattice steps around the major circle the counts aim for (p4: twice as many tiles). */
export const TARGET_NU = 30;
const NU_MIN = 12;
const NU_MAX = 60;
/** Weight of the distance from TARGET_NU against the tile aspect error (both as logs). */
const SIZE_WEIGHT = 0.1;

/** The conformal ratio of the minor to the major period: r / √(R² − r²), R = 1. @param {number} k */
export const conformalAspect = (k) => k / Math.sqrt(1 - k * k);

/**
 * Lattice counts around both circles. Plane x runs along the ring, y around the tube. The
 * tiling repeats every BLEND_PERIOD lattice steps (the warp and the colouring repeat every step,
 * the metamorphosis wave every BLEND_PERIOD), so both counts are multiples of it: nu steps of
 * (1, 0) around the ring, nv steps of the rectangular lattice vector (p4: (0, 1); p3: (0, √3))
 * around the tube. Chosen so ly / lx is close to the conformal ratio (square tiles), with nu
 * near TARGET_NU.
 * @param {string} group "p4" | "p3"
 * @param {number} k tube radius over major radius
 * @param {{ nu: number, nv: number, lx: number, ly: number }} out
 */
export function latticeCounts(group, k, out) {
  const step = group === "p3" ? S3 : 1;
  const want = conformalAspect(k);
  let best = Infinity;
  for (let nu = NU_MIN; nu <= NU_MAX; nu += BLEND_PERIOD) {
    const ideal = (want * nu) / step;
    for (const nv of [Math.floor(ideal / BLEND_PERIOD) * BLEND_PERIOD, Math.ceil(ideal / BLEND_PERIOD) * BLEND_PERIOD]) {
      if (nv < BLEND_PERIOD) continue;
      const cost = Math.abs(Math.log((nv * step) / nu / want)) + SIZE_WEIGHT * Math.abs(Math.log(nu / TARGET_NU));
      if (cost < best) {
        best = cost;
        out.nu = nu;
        out.nv = nv;
      }
    }
  }
  out.lx = out.nu;
  out.ly = out.nv * step;
  return out;
}

/**
 * The conformal fraction of the minor circle: t(φ) = (1/2π) ∫₀^φ r / (R + r cos ψ) dψ ÷ its
 * whole-circle value, in closed form (1/π) atan(√((R − r)/(R + r)) tan(φ/2)), written with atan2
 * so it is continuous on (−π, π]: t runs −½ … ½, 0 on the outer equator, ½ on the inner one.
 * With x ∝ θ, (θ, t) are conformal coordinates of the torus (shaders/tess/torus.frag mirrors it).
 * @param {number} phi in (−π, π] @param {number} k r / R
 */
export function minorFraction(phi, k) {
  const a = Math.sqrt((1 - k) / (1 + k));
  return Math.atan2(a * Math.sin(phi / 2), Math.cos(phi / 2)) / Math.PI;
}

/** dt/dφ = √(R² − r²) / (2π (R + r cos φ)). @param {number} phi @param {number} k */
export const minorRate = (phi, k) => Math.sqrt(1 - k * k) / (2 * Math.PI * (1 + k * Math.cos(phi)));

/**
 * The plane point of (θ, φ) with the flow offsets fu, fv (fractions of a turn).
 * @param {number} theta @param {number} phi @param {number} k
 * @param {{ lx: number, ly: number }} c @param {number} fu @param {number} fv @param {number[]} out
 */
export function planePoint(theta, phi, k, c, fu, fv, out) {
  out[0] = c.lx * (theta / (2 * Math.PI) + fu);
  out[1] = c.ly * (minorFraction(phi, k) + fv);
  return out;
}

/** A camera pose: position, unit heading and up (perpendicular). */
export const createPose = () => ({ pos: new Float64Array(3), fwd: new Float64Array(3), up: new Float64Array(3) });
/** @typedef {ReturnType<typeof createPose>} Pose */

/** Normalize v in place (unchanged if zero). @param {Float64Array} v */
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l > 0) for (let i = 0; i < 3; i++) v[i] /= l;
  return v;
}

/**
 * The fly-through pose: on the tube's centre circle at angle alpha, heading along it (towards
 * increasing θ), the up vector rolled about the heading by `roll`, then the look turned by
 * `yaw` (about up) and `pitch` (about the turned right).
 * @param {number} alpha @param {number} roll @param {number} yaw @param {number} pitch @param {Pose} pose
 */
export function insidePose(alpha, roll, yaw, pitch, pose) {
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  pose.pos[0] = ca;
  pose.pos[1] = 0;
  pose.pos[2] = sa;
  // Tangent T = (−sin α, 0, cos α); up = Y rolled about T: cos r · Y + sin r · (T × Y).
  const tx = -sa;
  const tz = ca;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ux = -tz * sr;
  const uy = cr;
  const uz = tx * sr;
  // right = T × up
  const rx = -tz * uy;
  const ry = tz * ux - tx * uz;
  const rz = tx * uy;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const fx = cy * tx + sy * rx;
  const fy = sy * ry;
  const fz = cy * tz + sy * rz;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  pose.fwd[0] = cp * fx + sp * ux;
  pose.fwd[1] = cp * fy + sp * uy;
  pose.fwd[2] = cp * fz + sp * uz;
  pose.up[0] = cp * ux - sp * fx;
  pose.up[1] = cp * uy - sp * fy;
  pose.up[2] = cp * uz - sp * fz;
  return pose;
}

/**
 * The orbit pose: `dist` from the centre at azimuth az (θ) and elevation el, looking at the
 * centre, up as close to +y as the heading allows. |el| stays below π/2.
 * @param {number} az @param {number} el @param {number} dist @param {Pose} pose
 */
export function outsidePose(az, el, dist, pose) {
  const ce = Math.cos(el);
  pose.fwd[0] = -ce * Math.cos(az);
  pose.fwd[1] = -Math.sin(el);
  pose.fwd[2] = -ce * Math.sin(az);
  for (let i = 0; i < 3; i++) pose.pos[i] = -dist * pose.fwd[i];
  const fy = pose.fwd[1];
  pose.up[0] = -fy * pose.fwd[0];
  pose.up[1] = 1 - fy * fy;
  pose.up[2] = -fy * pose.fwd[2];
  normalize(pose.up);
  return pose;
}

/**
 * Between two poses: position along the straight line (weight e), heading and up by normalized
 * lerp (weight h, so the turn can lag the move), up made perpendicular to the heading again.
 * Fine while the headings are never opposite (the orbit looks at the centre, the fly path along
 * the ring: always perpendicular).
 * @param {Pose} a @param {Pose} b @param {number} e position, 0 = a … 1 = b
 * @param {number} h heading and up, 0 = a … 1 = b @param {Pose} out
 */
export function blendPose(a, b, e, h, out) {
  for (let i = 0; i < 3; i++) {
    out.pos[i] = a.pos[i] + (b.pos[i] - a.pos[i]) * e;
    out.fwd[i] = a.fwd[i] + (b.fwd[i] - a.fwd[i]) * h;
    out.up[i] = a.up[i] + (b.up[i] - a.up[i]) * h;
  }
  normalize(out.fwd);
  const d = out.up[0] * out.fwd[0] + out.up[1] * out.fwd[1] + out.up[2] * out.fwd[2];
  for (let i = 0; i < 3; i++) out.up[i] -= d * out.fwd[i];
  normalize(out.up);
  return out;
}

/** View param options (manifest order). */
export const VIEWS = ["auto", "outside", "inside"];
/** @param {unknown} v → a VIEWS entry, auto if unknown */
export const viewName = (v) => (VIEWS.includes(String(v)) ? String(v) : "auto");
/** Seconds a dive in or out takes (smoothstep); reduce motion doubles it. */
export const DIVE_TIME = 6;
const REDUCED_DIVE = 2;
/** Auto: the view changes on phrase changes (every PHRASE_STEPS bar steps of lib/tess-music.js)… */
export const PHRASE_STEPS = 8;
/** …at least this many seconds after the last change… */
export const MIN_HOLD = 20;
/** …or after this long without one (no music: it still shows both). */
export const IDLE_TOGGLE = 60;

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Outside ↔ inside: `mix` 0 (orbiting outside) … 1 (flying inside), a smoothstep of a progress
 * that moves at 1 / DIVE_TIME towards the view's target. Auto toggles the target on phrase
 * changes (every PHRASE_STEPS bars, counted from the music's bar steps) once MIN_HOLD has passed,
 * or after IDLE_TOGGLE without one.
 */
export function createViewMix() {
  let progress = 0;
  let target = 0;
  let bars = 0;
  let since = 0;
  const v = {
    /** 0 outside … 1 inside. */
    mix: 0,
    /** @param {number} dt @param {{ view: string, stepped: boolean, reduceMotion: boolean }} o */
    step(dt, o) {
      since += dt;
      if (o.view === "outside") target = 0;
      else if (o.view === "inside") target = 1;
      else {
        const phrase = o.stepped && ++bars % PHRASE_STEPS === 0;
        if ((phrase && since >= MIN_HOLD) || since >= IDLE_TOGGLE) {
          target = 1 - target;
          since = 0;
        }
      }
      const rate = dt / (DIVE_TIME * (o.reduceMotion ? REDUCED_DIVE : 1));
      progress = target > progress ? Math.min(target, progress + rate) : Math.max(target, progress - rate);
      v.mix = smooth(progress);
      return v;
    },
  };
  return v;
}

/** The wall fade spans this fraction of the tube radius either side of the wall. */
const FADE_BAND = 0.6;

/**
 * How far the view dissolves into paper as the camera passes through the wall: 1 on the wall,
 * easing to 0 at FADE_BAND tube radii away (the tube's centre and the orbit are clear).
 * @param {ArrayLike<number>} p camera position @param {number} k tube radius
 */
export const wallFade = (p, k) => 1 - smooth(Math.abs(Math.hypot(Math.hypot(p[0], p[2]) - 1, p[1]) - k) / (FADE_BAND * k));

/** Drag sensitivity, radians per CSS pixel. */
export const DRAG_RATE = 0.005;
/** Drag pitch limit, radians either way. */
export const PITCH_LIMIT = 1.1;
/** Seconds the view takes to ease back after a drag (smoothstep). */
export const DRAG_RETURN = 1.6;

/**
 * Drag offsets: outside they orbit the camera (yaw about the torus's axis, pitch in elevation),
 * inside they turn the look. While held they follow the pointer; on release they ease back to
 * rest with a smoothstep over DRAG_RETURN (no jump, zero speed at both ends). A grab during the
 * return starts from where the view is.
 */
export function createDrag() {
  let held = false;
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  let t = DRAG_RETURN;
  const d = {
    yaw: 0,
    pitch: 0,
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      if (e.kind === "down") {
        held = true;
        x0 = e.x;
        y0 = e.y;
        yaw0 = d.yaw;
        pitch0 = d.pitch;
      } else if (e.kind === "move" && held) {
        d.yaw = yaw0 - (e.x - x0) * DRAG_RATE;
        d.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch0 + (e.y - y0) * DRAG_RATE));
      } else if (e.kind === "up" && held) {
        held = false;
        yaw0 = d.yaw;
        pitch0 = d.pitch;
        t = 0;
      }
    },
    /** @param {number} dt */
    step(dt) {
      if (held || t >= DRAG_RETURN) return d;
      t = Math.min(DRAG_RETURN, t + dt);
      const k = t >= DRAG_RETURN ? 0 : 1 - smooth(t / DRAG_RETURN);
      d.yaw = yaw0 * k;
      d.pitch = pitch0 * k;
      return d;
    },
  };
  return d;
}

/** Orbit distance from the torus's centre (R = 1), and its field of view (tan of half). */
export const DIST = 3.0;
const TAN_OUT = 0.52;
/** Inside: a wider view down the tube. */
const TAN_IN = 0.95;
/** Radians of azimuth per unit of glide travel: inside (the fly speed along the ring), outside. */
export const FLY = 0.2;
export const ORBIT = 0.04;
/** Tile flow, turns per unit of travel: along the ring (u) and around the tube (v, a slow twist). */
export const FLOW_U = 0.004;
export const FLOW_V = 0.006;
/** Outside tumble: elevation sway (rad) about EL0, on its own slow clock (rad/s). */
const EL0 = 0.42;
const EL_SWAY = 0.32;
const EL_RATE = 0.06;
/** The dive turns the heading down the tube from this view mix on. */
const TURN_FROM = 0.4;
/** Inside: roll about the heading, rad per unit of travel. */
const ROLL = 0.05;
/** Reduce motion: the tumble's clock runs at this rate (the glide is already slowed upstream). */
const REDUCED_CLOCK = 0.25;

const wrap1 = (/** @type {number} */ x) => x - Math.floor(x);

/**
 * The whole camera: orbit outside, fly inside, the dive between (createViewMix), drag. One
 * azimuth `az` is shared: outside it is the orbit's, inside the fly path's angle on the ring, so
 * the dive goes straight in where the camera is and comes back out where it has flown to. Speed
 * comes from the state's glide travel (bass and the eased beat surge). Writes, in place: the
 * blended pose, tan of half the vertical field of view, which side of the wall the camera is on
 * (`side` +1 outside, −1 inside), the paper fade while crossing it, the tile flow offsets
 * (`fu`, `fv`, turns) and the ring origin of the figure/ground front (`ringO`, a fraction of the
 * ring in plane terms: the camera's azimuth plus the flow).
 */
export function createTorusCamera() {
  const view = createViewMix();
  const drag = createDrag();
  const out = createPose();
  const ins = createPose();
  let lastTravel = NaN;
  let clock = 0;
  let roll = 0;
  const c = {
    pose: createPose(),
    mix: 0,
    side: 1,
    fade: 0,
    az: 0.6,
    fu: 0,
    fv: 0,
    ringO: 0,
    tanHalf: TAN_OUT,
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      drag.pointer(e);
    },
    /**
     * @param {number} dt
     * @param {{ travel: number }} s lib/tess-music.js state (its glide travel)
     * @param {{ view: string, thickness: number, stepped: boolean, reduceMotion: boolean }} o
     */
    step(dt, s, o) {
      const step = Number.isNaN(lastTravel) ? 0 : s.travel - lastTravel;
      lastTravel = s.travel;
      view.step(dt, o);
      drag.step(dt);
      const m = view.mix;
      c.mix = m;
      c.az += step * (ORBIT + (FLY - ORBIT) * m);
      c.fu = wrap1(c.fu + FLOW_U * step);
      c.fv = wrap1(c.fv + FLOW_V * step);
      roll += ROLL * step;
      clock += dt * (o.reduceMotion ? REDUCED_CLOCK : 1);
      const el = EL0 + EL_SWAY * Math.sin(clock * EL_RATE + 0.4) - EL_SWAY * Math.sin(0.4);
      const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, el + drag.pitch));
      outsidePose(c.az + drag.yaw, pitch, DIST, out);
      // The roll fades in with the dive, so the two up vectors never disagree much.
      insidePose(c.az, Math.sin(roll) * 0.6 * m, drag.yaw, drag.pitch, ins);
      // The heading turns down the tube only in the last part of the dive: until then the
      // camera keeps the torus in view as it closes in.
      blendPose(out, ins, m, smooth((m - TURN_FROM) / (1 - TURN_FROM)), c.pose);
      c.tanHalf = TAN_OUT + (TAN_IN - TAN_OUT) * m;
      const p = c.pose.pos;
      c.side = Math.hypot(Math.hypot(p[0], p[2]) - 1, p[1]) < o.thickness ? -1 : 1;
      c.fade = m > 0 && m < 1 ? wallFade(p, o.thickness) : 0;
      c.ringO = wrap1(c.az / (2 * Math.PI) + c.fu);
      return c;
    },
  };
  return c;
}

/** Thickness param: tube radius over ring radius. */
export const THICKNESS = { min: 0.2, max: 0.5, default: 0.36 };
/** Travel time param: seconds for a wave to roll a full lap round the tube. */
export const TRAVEL = { min: 1, max: 8, default: 4 };
const SYMS = ["p4", "p3"];
/** @param {unknown} x @param {number} lo @param {number} hi @param {number} dflt */
const num = (x, lo, hi, dflt) => {
  const v = Number(x);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
};

/**
 * The manifest params as the visualizer uses them (clamped, unknown → default). Writes into
 * `out` (no allocation per frame) and returns it.
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>} p ctx.params @param {T} out
 */
export function mapParams(p, out) {
  const o = /** @type {Record<string, unknown>} */ (out);
  o.view = viewName(p.view);
  o.symmetry = SYMS.includes(String(p.symmetry)) ? String(p.symmetry) : "p4";
  o.thickness = num(p.thickness, THICKNESS.min, THICKNESS.max, THICKNESS.default);
  o.palette = String(p.palette ?? "");
  o.reactivity = num(p.reactivity, 0, 2, 1);
  o.speed = num(p.speed, 0, 2, 1);
  o.morph = num(p.morph, 0, 1, 0.7);
  o.ink = num(p.ink, 0, 2, 1);
  o.hatching = num(p.hatching, 0, 1, 0.6);
  o.wave = num(p.wave, 0, 1, 0.7);
  o.travel = num(p.travel, TRAVEL.min, TRAVEL.max, TRAVEL.default);
  o.detail = num(p.detail, 0, 1, 0.15);
  return out;
}
/**
 * Render scale inside the tube per Quality: looking down it, nearly every wall is seen at a
 * grazing angle, where the displaced march takes the most steps, so the inside prints at a lower
 * scale than lib/tess-music.js renderScale's (1 / 0.75 / 0.5). The visualizer switches when the
 * camera crosses the wall, under the full paper fade.
 * @param {unknown} q Quality param
 */
export const insideScale = (q) => (q === "low" ? 0.45 : q === "medium" ? 0.6 : 0.8);
