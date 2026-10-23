// @ts-check
/** Möbius Field's camera: flies forward along a gently curving path through the bands. */

/** Speed (units/s) at which the path's curves run at their nominal pace. */
export const NOMINAL_SPEED = 1.4;
/** Vertical field of view, radians (wider than the orbit camera's: we're inside the field). */
export const FLY_FOV = (60 * Math.PI) / 180;

/** Look-around drag, radians per CSS pixel. */
export const LOOK_RATE = 0.004;

/** Extra speed at the beat envelope's peak, per unit of Beat. */
export const SURGE = 0.6;

/**
 * The path's heading at path clock c (nominal seconds): a few slow, incommensurate sines, so it
 * never repeats and every derivative is smooth. Yaw wanders about ±2 rad, pitch stays within
 * about ±0.2 rad.
 * @param {number} c
 */
const pathYaw = (c) =>
  1.1 * Math.sin(0.083 * c) + 0.7 * Math.sin(0.031 * c + 1.3) + 0.35 * Math.sin(0.19 * c + 0.4);
/** @param {number} c */
const pathPitch = (c) => 0.14 * Math.sin(0.067 * c + 0.9) + 0.07 * Math.sin(0.15 * c + 2.2);

/** Most look-around pitch either way, radians. */
const LOOK_PITCH = 1.1;
/** The release spring's rate (1/s): critically damped, so it starts from rest and never overshoots. */
const RETURN = 2.5;

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
/** @type {[number, number]} reused by {@link settle} */
const spring = [0, 0];

export function createFly() {
  let clock = 0;
  let dragging = false;
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  let vYaw = 0;
  let vPitch = 0;
  const fly = {
    /** Path heading: radians about the vertical (0 looks down −z) and above the horizon. */
    yaw: pathYaw(0),
    pitch: pathPitch(0),
    /** Drag look-around, radians on top of the path heading (eased back to 0 after release). */
    lookYaw: 0,
    lookPitch: 0,
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      if (e.kind === "down") {
        dragging = true;
        x0 = e.x;
        y0 = e.y;
        yaw0 = fly.lookYaw;
        pitch0 = fly.lookPitch;
        vYaw = 0;
        vPitch = 0;
      } else if (e.kind === "move" && dragging) {
        fly.lookYaw = yaw0 - (e.x - x0) * LOOK_RATE;
        const p = pitch0 + (e.y - y0) * LOOK_RATE;
        fly.lookPitch = p > LOOK_PITCH ? LOOK_PITCH : p < -LOOK_PITCH ? -LOOK_PITCH : p;
      } else if (e.kind === "up") {
        dragging = false;
      }
    },
    /** Column-major projection matrix, rewritten in place by `writeMatrices`. */
    proj: new Float32Array(16),
    /** Column-major view matrix: rotation only, the camera at the origin of the bands' offsets. */
    view: new Float32Array(16),
    /** Half-angle tangents of the view (for culling), set by `writeMatrices`. */
    tanX: 0,
    tanY: 0,
    /** @param {number} aspect width ÷ height @param {number} far */
    writeMatrices(aspect, far) {
      const near = 0.05;
      const f = 1 / Math.tan(FLY_FOV / 2);
      const nf = 1 / (near - far);
      const P = fly.proj;
      P.fill(0);
      P[0] = f / aspect;
      P[5] = f;
      P[10] = (far + near) * nf;
      P[11] = -1;
      P[14] = 2 * far * near * nf;
      fly.tanY = 1 / f;
      fly.tanX = aspect / f;
      // Rows: right (level), up, back (−forward).
      const yaw = fly.yaw + fly.lookYaw;
      const pitch = fly.pitch + fly.lookPitch;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const V = fly.view;
      V[0] = cy;
      V[4] = 0;
      V[8] = sy;
      V[1] = -sp * sy;
      V[5] = cp;
      V[9] = sp * cy;
      V[2] = -cp * sy;
      V[6] = -sp;
      V[10] = cp * cy;
      V[3] = 0;
      V[7] = 0;
      V[11] = 0;
      V[12] = 0;
      V[13] = 0;
      V[14] = 0;
      V[15] = 1;
    },
    /** This frame's speed, units/s: the base speed plus the beat surge. */
    speed: 0,
    /** Camera position, world space (float64: it flies forever). */
    pos: new Float64Array(3),
    /**
     * Fly on. The path's curves run on the base speed alone, so a surge never jerks the turning.
     * @param {number} dt seconds @param {number} speed base speed, units/s (Speed, after `gentle`)
     * @param {number} env createBeat's `env` @param {number} beat the surge's Beat (after `gentle`)
     */
    update(dt, speed, env, beat) {
      clock += (dt * speed) / NOMINAL_SPEED;
      fly.yaw = pathYaw(clock);
      fly.pitch = pathPitch(clock);
      if (!dragging) {
        settle(fly.lookYaw, vYaw, dt);
        fly.lookYaw = spring[0];
        vYaw = spring[1];
        settle(fly.lookPitch, vPitch, dt);
        fly.lookPitch = spring[0];
        vPitch = spring[1];
      }
      fly.speed = speed * (1 + SURGE * env * beat);
      const step = fly.speed * dt;
      const cp = Math.cos(fly.pitch);
      fly.pos[0] += step * Math.sin(fly.yaw) * cp;
      fly.pos[1] += step * Math.sin(fly.pitch);
      fly.pos[2] -= step * Math.cos(fly.yaw) * cp;
    },
  };
  return fly;
}
