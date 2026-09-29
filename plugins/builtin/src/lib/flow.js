// @ts-check
/**
 * Pure, allocation-free math for Laminar's fluid sim (the GPU side lives in shaders/laminar/).
 */
import { createStepper } from "./fire.js";

/** Sim steps per second: fixed, so the flow evolves the same at 60 and 120 Hz. */
export const SIM_RATE = 60;
/** At most this many sim steps per frame; a longer backlog (stall, hidden tab) is dropped. */
export const MAX_STEPS = 3;

/**
 * The sim's fixed-timestep clock (Blaze's dt accumulator at Laminar's rate): `step(frameDt)`
 * returns how many steps of `dt` = 1 / SIM_RATE s to run this frame.
 */
export function createSimClock() {
  const s = createStepper(SIM_RATE, MAX_STEPS);
  return { dt: 1 / SIM_RATE, step: s.step, reset: s.reset };
}

/**
 * @param {number} x @param {number} y @param {number} cx @param {number} cy @param {number} r
 * @param {number} vx @param {number} vy @param {number} dr @param {Float32Array | number[]} out
 */
export function obstacleVelocity(x, y, cx, cy, r, vx, vy, dr, out) {
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy >= r * r) return false;
  const k = r > 0 ? dr / r : 0;
  out[0] = vx + k * dx;
  out[1] = vy + k * dy;
  return true;
}

const DETAIL_MIN = 0.08;
const DETAIL_MAX = 0.4;
const DETAIL_DEFAULT = 0.2;
const GRID_MAX = 1024;
const GRID_MIN = 16;

/**
 * The simulation grid. The sim runs in the flow's own frame — inflow along +x from the left edge,
 * outflow at the right — and the composite rotates it by `angle` onto the screen, so the grid is
 * the bounding box of the canvas rotated into that frame: `lx` × `ly` screen heights, `cells`
 * square cells per screen height (canvas height × detail, fewer if a side would pass 1024).
 * Called on resize / Detail change only (allocates the result).
 * @param {number} width canvas drawing-buffer pixels
 * @param {number} height
 * @param {number} detail sim cells per canvas pixel (0.08–0.4)
 * @param {number} angle flow direction on screen, radians
 */
export function simGrid(width, height, detail, angle) {
  const d = Number.isFinite(detail) ? Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, detail)) : DETAIL_DEFAULT;
  const a = width / Math.max(1, height);
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const lx = a * c + s;
  const ly = a * s + c;
  let cells = height * d;
  const longest = Math.max(lx, ly) * cells;
  if (longest > GRID_MAX) cells *= GRID_MAX / longest;
  return {
    lx,
    ly,
    cells,
    width: Math.max(GRID_MIN, Math.min(GRID_MAX, Math.ceil(lx * cells - 1e-9))),
    height: Math.max(GRID_MIN, Math.min(GRID_MAX, Math.ceil(ly * cells - 1e-9))),
  };
}

/** Fraction of each line period covered by the (raised) line; the rest is the dark gap. */
export const LINE_DUTY = 0.56;
const EDGE0 = 0.5 - LINE_DUTY / 2;

/** Integral from 0 to x of the periodic pulse (1 on [EDGE0, EDGE0 + LINE_DUTY) of each period). @param {number} x */
function pulseIntegral(x) {
  const f = x - Math.floor(x);
  const t = f - EDGE0;
  return Math.floor(x) * LINE_DUTY + (t < 0 ? 0 : t > LINE_DUTY ? LINE_DUTY : t);
}

/**
 * How much of a pixel the lines cover: the lines are the contours φ·k = n + ½ of the line
 * coordinate φ (screen heights), each LINE_DUTY of a period wide, box-filtered over the pixel's
 * footprint `w` (in periods: fwidth(φ·k) in the shader), so edges are anti-aliased exactly and a
 * pattern finer than a pixel averages out to LINE_DUTY instead of aliasing into speckle.
 * @param {number} phi line coordinate
 * @param {number} k lines per screen height
 * @param {number} w filter width in periods
 */
export function lineCoverage(phi, k, w) {
  const x = phi * k;
  const h = w > 1e-4 ? 0.5 * w : 5e-5;
  const c = (pulseIntegral(x + h) - pulseIntegral(x - h)) / (2 * h);
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/**
 * One semi-Lagrangian step of the line field on the CPU — the reference for the shader, which
 * does the same per texel (plus a MacCormack correction). The field stores the displacement
 * ψ = φ − y of the line coordinate φ from the cell's own cross-stream coordinate y (screen
 * heights), so a laminar region is exactly 0 and half floats keep full precision where it counts.
 * Carrying φ back along the flow gives ψ'(x) = ψ(x_b) + y_b − y. A backtrace that leaves through
 * the inflow edge (x_b < 0), and the inflow column itself, pick up a fresh, straight line:
 * φ = y_b, ψ' = y_b − y.
 * Uniform velocity (vx, vy) in screen heights / s; `cells` per screen height; clamp-to-edge.
 * @param {Float32Array} psi nx × ny, row-major (y up)
 * @param {Float32Array} out nx × ny
 * @param {number} nx @param {number} ny @param {number} cells
 * @param {number} vx @param {number} vy @param {number} dt seconds
 */
export function advectLines(psi, out, nx, ny, cells, vx, vy, dt) {
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // Backtrace in cell units.
      const bx = i - vx * dt * cells;
      const by = j - vy * dt * cells;
      const shift = (by - j) / cells; // y_b − y
      // The inflow column is held fresh (Dirichlet), as is anything whose backtrace leaves the grid.
      if (i === 0 || bx < -0.5) {
        out[j * nx + i] = shift;
        continue;
      }
      const cx = bx < 0 ? 0 : bx > nx - 1 ? nx - 1 : bx;
      const cy = by < 0 ? 0 : by > ny - 1 ? ny - 1 : by;
      const i0 = Math.floor(cx);
      const j0 = Math.floor(cy);
      const i1 = i0 + 1 < nx ? i0 + 1 : nx - 1;
      const j1 = j0 + 1 < ny ? j0 + 1 : ny - 1;
      const fx = cx - i0;
      const fy = cy - j0;
      const a = psi[j0 * nx + i0] + (psi[j0 * nx + i1] - psi[j0 * nx + i0]) * fx;
      const b = psi[j1 * nx + i0] + (psi[j1 * nx + i1] - psi[j1 * nx + i0]) * fx;
      out[j * nx + i] = a + (b - a) * fy + shift;
    }
  }
}
