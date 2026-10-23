// @ts-check
/**
 * Tile Horizon's camera and param mapping: a camera gliding low over the endless tiling plane
 * (z = 0, plane units = lattice units), looking down at the pitch towards a slowly drifting
 * heading. The glide is the tessellation state's travel (bass and the eased beat surge,
 * lib/tess-music.js), scaled by the camera height so the floor's apparent speed doesn't depend
 * on it. Drag grabs the world (pan and tilt); on release the view eases back along a critically
 * damped spring, which leaves at rest and never overshoots. Pure; `step` allocates nothing.
 */
import { BLEND_PERIOD } from "./tess-music.js";

/** Camera height range (plane units; p4 tiles are half a unit) for Height 0–1. */
export const HEIGHT_MIN = 0.25;
export const HEIGHT_MAX = 1.5;
/** How far the view looks down (rad below the horizon) for Tilt 0–1. */
export const PITCH_MIN = 0.06;
export const PITCH_MAX = 0.6;
/** Fog distance in camera heights for Fog 0 and Fog 1. */
export const FOG_FAR = 40;
export const FOG_NEAR = 8;
/** Ground travelled per unit of glide travel, per unit of camera height. */
export const FLY = 0.6;
/** Heading drift: base heading (rad) plus two slow sways (amplitude rad, rate rad/s). */
const HEADING = 0.6;
const SWAY_A = 0.9;
const SWAY_W = 0.031;
const SWAY2_A = 0.3;
const SWAY2_W = 0.077;
/** Reduce motion: the heading drifts and the view eases back this much slower. */
export const REDUCED = 0.25;
/** Drag sensitivity (rad per CSS px) for pan and tilt. */
export const DRAG_PAN = 0.004;
export const DRAG_TILT = 0.003;
/** Most a drag turns the view either way (rad). */
const PAN_LIMIT = 1.2;
/** Pitch limits while dragging: just above the horizon … nearly straight down. */
const TILT_LO = 0.03;
const TILT_HI = 1.3;
/** Ease-back spring rate (1/s): critically damped, ~98 % back in 2.6 s. */
const EASE_W = 2.2;

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** A 0–1 param, `fallback` if it isn't a number. @param {unknown} v @param {number} fallback */
const unit = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
};

/** Height param (0–1) → camera height, plane units. @param {unknown} v */
export const cameraHeight = (v) => HEIGHT_MIN + (HEIGHT_MAX - HEIGHT_MIN) * unit(v, 0.5);
/** Tilt param (0–1) → pitch below the horizon, rad. @param {unknown} v */
export const basePitch = (v) => PITCH_MIN + (PITCH_MAX - PITCH_MIN) * unit(v, 0.5);
/** Fog param (0–1) and camera height → distance (plane units) where the floor is paper. @param {unknown} fog @param {number} height */
export const fogDistance = (fog, height) => height * (FOG_FAR + (FOG_NEAR - FOG_FAR) * unit(fog, 0.5));

/**
 * @typedef {object} FloorInput
 * @property {number} travel the state's unwrapped glide travel
 * @property {number} height camera height (cameraHeight)
 * @property {number} pitch base pitch (basePitch)
 * @property {boolean} reduceMotion
 * @property {number[][]} basis the group's lattice basis (wraps the position)
 */

/**
 * Exact step of a critically damped spring towards 0 (state x, v; rate w) over dt.
 * @param {Float64Array} s [x, v] @param {number} i offset @param {number} w @param {number} dt
 */
function spring(s, i, w, dt) {
  const x = s[i];
  const v = s[i + 1];
  const e = Math.exp(-w * dt);
  const c = v + w * x;
  s[i] = (x + c * dt) * e;
  s[i + 1] = (v - w * c * dt) * e;
}

export function createFloorCamera() {
  let clock = 0;
  let lastTravel = Number.NaN;
  let base = PITCH_MIN;
  let x0 = 0;
  let y0 = 0;
  let pan0 = 0;
  let tilt0 = 0;
  /** pan, its velocity, tilt, its velocity (the ease-back springs) */
  const ease = new Float64Array(4);
  const cam = {
    /** Camera ground position (plane units), wrapped every BLEND_PERIOD lattice steps. */
    x: 0.37,
    y: 0.21,
    /** Height above the plane. */
    h: HEIGHT_MIN,
    /** Direction of travel (rad). */
    heading: HEADING,
    /** View direction: heading + pan; pitch below the horizon (base + tilt). */
    yaw: HEADING,
    pitch: PITCH_MIN,
    /** Drag offsets (rad). */
    pan: 0,
    tilt: 0,
    dragging: false,
    /** View basis (world xyz): forward, right (level), up. */
    fwd: new Float32Array(3),
    right: new Float32Array(3),
    up: new Float32Array(3),
    /** @param {number} dt seconds @param {FloorInput} o */
    step(dt, o) {
      const slow = o.reduceMotion ? REDUCED : 1;
      clock += dt * slow;
      cam.heading = HEADING + SWAY_A * Math.sin(SWAY_W * clock) + SWAY2_A * Math.sin(SWAY2_W * clock);
      const step = Number.isNaN(lastTravel) ? 0 : o.travel - lastTravel;
      lastTravel = o.travel;
      cam.h = o.height;
      cam.x += Math.cos(cam.heading) * FLY * o.height * step;
      cam.y += Math.sin(cam.heading) * FLY * o.height * step;
      // The tiling and its blend wave repeat every BLEND_PERIOD lattice steps: wrap there.
      const b = o.basis;
      const det = b[0][0] * b[1][1] - b[1][0] * b[0][1];
      let la = (cam.x * b[1][1] - cam.y * b[1][0]) / det;
      let lb = (cam.y * b[0][0] - cam.x * b[0][1]) / det;
      la -= BLEND_PERIOD * Math.floor(la / BLEND_PERIOD);
      lb -= BLEND_PERIOD * Math.floor(lb / BLEND_PERIOD);
      cam.x = la * b[0][0] + lb * b[1][0];
      cam.y = la * b[0][1] + lb * b[1][1];

      base = o.pitch;
      if (!cam.dragging) {
        spring(ease, 0, EASE_W * (o.reduceMotion ? 0.5 : 1), dt);
        spring(ease, 2, EASE_W * (o.reduceMotion ? 0.5 : 1), dt);
        cam.pan = ease[0];
        cam.tilt = ease[2];
      }
      cam.yaw = cam.heading + cam.pan;
      cam.pitch = clamp(base + cam.tilt, TILT_LO, TILT_HI);

      const cy = Math.cos(cam.yaw);
      const sy = Math.sin(cam.yaw);
      const cp = Math.cos(cam.pitch);
      const sp = Math.sin(cam.pitch);
      cam.fwd[0] = cy * cp;
      cam.fwd[1] = sy * cp;
      cam.fwd[2] = -sp;
      cam.right[0] = sy;
      cam.right[1] = -cy;
      cam.right[2] = 0;
      cam.up[0] = cy * sp;
      cam.up[1] = sy * sp;
      cam.up[2] = cp;
      return cam;
    },
    /**
     * Drag grabs the world: right turns the view left, down tilts it up. A new drag picks the
     * view up where the ease-back has got to.
     * @param {import('../../tidalviz').PointerInput} e
     */
    pointer(e) {
      if (e.kind === "down") {
        cam.dragging = true;
        x0 = e.x;
        y0 = e.y;
        pan0 = cam.pan;
        tilt0 = cam.tilt;
      } else if (e.kind === "move" && cam.dragging) {
        cam.pan = clamp(pan0 + (e.x - x0) * DRAG_PAN, -PAN_LIMIT, PAN_LIMIT);
        cam.tilt = clamp(base + tilt0 - (e.y - y0) * DRAG_TILT, TILT_LO, TILT_HI) - base;
      } else if (e.kind === "up" && cam.dragging) {
        cam.dragging = false;
        ease[0] = cam.pan;
        ease[1] = 0;
        ease[2] = cam.tilt;
        ease[3] = 0;
      }
    },
  };
  return cam;
}
