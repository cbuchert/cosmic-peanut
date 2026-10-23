// @ts-check
/**
 * Endless Zoom's surface maths (the tiling is lib/tess.js, the music lib/tess-music.js): the
 * log-polar map's closure choices, the zoom's plane offset, the drag of the vanishing point,
 * and the param mapping. Nothing here allocates per frame.
 *
 * The surface maps a pixel z (relative to the vanishing point) to the plane point
 * p = α log z + O. One turn round the centre adds 2πi to log z and so V = α·2πi to p
 * (lib/tess.js drosteAlpha): V must be a lattice vector for the tiles to close, and the
 * metamorphosis blend wave (period BLEND_PERIOD lattice steps) must repeat over it too, or the
 * shapes would jump at the seam. Zooming moves log z along the real axis, i.e. p along α.
 */
import { BLEND_PERIOD, symmetryName } from "./tess-music.js";

/** Spiral param options: how far the lattice climbs per turn round the centre. */
export const SPIRALS = ["none", "gentle", "medium", "strong"];
/** Per option, b of V = a e1 + b e2; a = BLEND_PERIOD (the blend wave runs along e1). b = 3
 * still reads as a mild twist; 6 gives real arms. */
const TWIST = [0, 1, 3, 6];

/**
 * The lattice vector V = a e1 + b e2 one turn round the centre moves the plane by. Both groups'
 * blend waves have k·e1 = 1/BLEND_PERIOD and k·e2 = 0, so a = BLEND_PERIOD closes both the tiles
 * and the wave; b sets the twist. Unknown names → "none".
 * @param {unknown} name @param {number[]} out a, b
 */
export function spiralVector(name, out) {
  const i = Math.max(0, SPIRALS.indexOf(String(name)));
  out[0] = BLEND_PERIOD;
  out[1] = TWIST[i];
  return out;
}

/** Zoom (natural-log scale per unit of glide travel) at Zoom speed 1: ×e every ~5 s at rest. */
export const ZOOM_RATE = 0.2;
/** A Direction change eases the zoom's sign through 0 with this time constant (s). */
const DIR_TAU = 0.6;
/** Direction param options: in = into the vanishing point (the plane flows outward). */
export const DIRECTIONS = ["in", "out"];
/** @param {unknown} name → +1 (in) or −1 (out); unknown → in */
export const directionSign = (name) => (String(name) === "out" ? -1 : 1);

/**
 * @typedef {object} ZoomInput
 * @property {import('./tess.js').Group} group
 * @property {unknown} spiral SPIRALS @property {number} zoomSpeed the Zoom speed param (≥ 0)
 * @property {unknown} direction DIRECTIONS
 */

/**
 * The zoom: log z shifts by `phase` along the real axis, which moves the plane point by −α·phase:
 * zooming in, a fixed plane point drifts to a larger radius. The plane offset O wraps by whole
 * BLEND_PERIOD lattice steps (where the tiling and the blend wave both repeat), so the zoom runs
 * forever with small floats and never jumps.
 */
export function createZoom() {
  const v = [0, 0];
  const z = {
    /** Plane offset O (`u_O`). */
    ox: 0,
    oy: 0,
    /** Complex scale α of p = α log z + O (`u_alpha`). */
    alpha: [0, 0],
    /** Eased direction, −1 (out) … 1 (in). */
    dir: 1,
    /** Unwrapped zoom so far (natural-log scale) and the last step's share. */
    phase: 0,
    lastStep: 0,
    /** @param {number} travel this frame's glide travel @param {number} dt @param {ZoomInput} o */
    step(travel, dt, o) {
      const g = o.group;
      spiralVector(o.spiral, v);
      const vx = v[0] * g.basis[0][0] + v[1] * g.basis[1][0];
      const vy = v[0] * g.basis[0][1] + v[1] * g.basis[1][1];
      z.alpha[0] = vy / (2 * Math.PI); // drosteAlpha, inlined to stay allocation-free
      z.alpha[1] = -vx / (2 * Math.PI);
      z.dir += (directionSign(o.direction) - z.dir) * (1 - Math.exp(-dt / DIR_TAU));
      const d = ZOOM_RATE * Math.max(0, o.zoomSpeed) * travel * z.dir;
      z.lastStep = d;
      z.phase += d;
      let ox = z.ox - z.alpha[0] * d;
      let oy = z.oy - z.alpha[1] * d;
      const b = g.basis;
      const det = b[0][0] * b[1][1] - b[1][0] * b[0][1];
      let la = (ox * b[1][1] - oy * b[1][0]) / det;
      let lb = (oy * b[0][0] - ox * b[0][1]) / det;
      la -= BLEND_PERIOD * Math.floor(la / BLEND_PERIOD);
      lb -= BLEND_PERIOD * Math.floor(lb / BLEND_PERIOD);
      z.ox = la * b[0][0] + lb * b[1][0];
      z.oy = la * b[0][1] + lb * b[1][1];
      return z;
    },
  };
  return z;
}

/** Drag: furthest the vanishing point goes from the centre (screen units: half the short side). */
export const DRAG_MAX = 0.75;
/** Seconds the vanishing point takes to ease home after release (a smoothstep: no kick). */
export const DRAG_RETURN = 1.4;
/** The soft vanishing point: tiles fade into it between these radii (screen units). */
export const VANISH = [0.015, 0.11];

/**
 * Drag on the visual moves the vanishing point (screen units, y up); on release it eases home
 * over DRAG_RETURN with a smoothstep, so it leaves and lands with zero speed.
 */
export function createDrag() {
  let fromX = 0;
  let fromY = 0;
  let t = Infinity;
  const d = {
    /** Vanishing point offset from the centre (screen units, y up). */
    x: 0,
    y: 0,
    held: false,
    /**
     * @param {string} kind "down" | "move" | "up" @param {number} dx @param {number} dy CSS px
     * @param {number} unit CSS px per screen unit
     */
    pointer(kind, dx, dy, unit) {
      if (kind === "down") {
        d.held = true;
      } else if (kind === "move" && d.held) {
        d.x += dx / unit;
        d.y -= dy / unit;
        const r = Math.hypot(d.x, d.y);
        if (r > DRAG_MAX) {
          d.x *= DRAG_MAX / r;
          d.y *= DRAG_MAX / r;
        }
      } else if (kind === "up" && d.held) {
        d.held = false;
        fromX = d.x;
        fromY = d.y;
        t = 0;
      }
    },
    /** @param {number} dt */
    step(dt) {
      if (d.held || t === Infinity) return d;
      t += dt;
      if (t >= DRAG_RETURN) {
        d.x = 0;
        d.y = 0;
        t = Infinity;
        return d;
      }
      const u = t / DRAG_RETURN;
      const k = 1 - u * u * (3 - 2 * u);
      d.x = fromX * k;
      d.y = fromY * k;
      return d;
    },
  };
  return d;
}

/**
 * The rings (lib/tess-music.js figure/ground front and spectrum rings) by log radius: from the
 * vanishing point's soft edge (VANISH[1]) to the view's farthest corner, so a front ripples along
 * the spiral from the centre outward (or, flipped, inward).
 * @param {number} halfW @param {number} halfH the view's half extents (screen units)
 * @param {number} cx @param {number} cy the vanishing point @param {number[]} out log r: lo, hi
 */
export function ringSpan(halfW, halfH, cx, cy, out) {
  out[0] = Math.log(VANISH[1]);
  out[1] = Math.log(Math.hypot(halfW + Math.abs(cx), halfH + Math.abs(cy)));
  return out;
}

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));

/** Default Spiral option. */
export const DEFAULT_SPIRAL = "gentle";

/**
 * @typedef {object} ZoomParams
 * @property {string} symmetry @property {string} palette @property {number} reactivity
 * @property {number} speed @property {number} morph @property {number} ink
 * @property {number} hatching @property {string} spiral @property {number} zoomSpeed
 * @property {string} direction
 */

/**
 * The visualizer's params (Metamorphosis's, plus spiral, zoom, direction) into `out`, clamped to
 * the manifest's ranges; unknown options fall back. Allocates nothing.
 * @param {Record<string, unknown>} p ctx.params @param {ZoomParams} out
 */
export function readParams(p, out) {
  out.symmetry = symmetryName(p.symmetry);
  out.palette = String(p.palette);
  out.reactivity = clamp(Number(p.reactivity), 0, 2);
  out.speed = clamp(Number(p.speed), 0, 2);
  out.morph = clamp(Number(p.morph), 0, 1);
  out.ink = clamp(Number(p.ink), 0, 2);
  out.hatching = clamp(Number(p.hatching), 0, 1);
  out.spiral = SPIRALS.includes(String(p.spiral)) ? String(p.spiral) : DEFAULT_SPIRAL;
  out.zoomSpeed = clamp(Number(p.zoom), 0, 2);
  out.direction = DIRECTIONS[directionSign(p.direction) > 0 ? 0 : 1];
  return out;
}
