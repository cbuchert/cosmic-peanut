// @ts-check
/** Self-orbiting camera with drag override (PRD "Camera and motion"). */

/** Pitch limit, radians either side of the equator. */
export const PITCH_LIMIT = 1.3;
/** Orbit speed at which the pitch sway runs at its nominal pace. */
const NOMINAL_ORBIT = 0.12;

/** Drag sensitivity, radians per CSS pixel. */
export const DRAG_RATE = 0.006;

/** @param {number} p */
const clampPitch = (p) => (p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p);

export function createCamera() {
  const cam = {
    /** Radians around the vertical axis. */
    yaw: 0.4,
    /** Radians above the equator. */
    pitch: 0.42,
    /** Center of the pitch sway (slightly above the equator by default). */
    basePitch: 0.42,
    /** Sway clock: advances only while orbiting, scaled by |orbit| ÷ 0.12. */
    t: 0,
    dragging: false,
    /** Column-major projection matrix, rewritten in place by {@link writeMatrices}. */
    proj: new Float32Array(16),
    /** Column-major view matrix (camera at the orbit position, looking at the origin). */
    view: new Float32Array(16),
    /**
     * Advance the self-orbit.
     * @param {number} dt seconds
     * @param {number} orbit yaw speed, rad/s (negative reverses)
     */
    update(dt, orbit) {
      if (cam.dragging) return;
      cam.yaw += orbit * dt;
      cam.t += (dt * Math.abs(orbit)) / NOMINAL_ORBIT;
      cam.pitch = clampPitch(cam.basePitch + 0.3 * Math.sin(0.09 * cam.t));
    },
    /**
     * Drag to orbit: horizontal drag turns yaw, vertical drag tilts pitch. On release the sway
     * center is recomputed so the self-orbit continues from here without a jump.
     * @param {import('../../tidalviz').PointerInput} e
     */
    pointer(e) {
      if (e.kind === "down") {
        cam.dragging = true;
        x0 = e.x;
        y0 = e.y;
        yaw0 = cam.yaw;
        pitch0 = cam.pitch;
      } else if (e.kind === "move" && cam.dragging) {
        cam.yaw = yaw0 - (e.x - x0) * DRAG_RATE;
        cam.pitch = clampPitch(pitch0 + (e.y - y0) * DRAG_RATE);
      } else if (e.kind === "up" && cam.dragging) {
        cam.dragging = false;
        cam.basePitch = cam.pitch - 0.3 * Math.sin(0.09 * cam.t);
      }
    },
    /**
     * Write the projection and view matrices for the current yaw and pitch. No allocation.
     * @param {number} aspect width ÷ height
     * @param {number} dist camera distance from the origin
     */
    writeMatrices(aspect, dist) {
      const near = 0.1;
      const far = 50;
      const f = 1 / Math.tan(FOV / 2);
      const nf = 1 / (near - far);
      const P = cam.proj;
      P.fill(0);
      P[0] = f / aspect;
      P[5] = f;
      P[10] = (far + near) * nf;
      P[11] = -1;
      P[14] = 2 * far * near * nf;

      // Eye on the orbit sphere; z axis points from the origin to the eye, x stays horizontal.
      const cp = Math.cos(cam.pitch);
      const ex = dist * cp * Math.sin(cam.yaw);
      const ey = dist * Math.sin(cam.pitch);
      const ez = dist * cp * Math.cos(cam.yaw);
      const zx = ex / dist;
      const zy = ey / dist;
      const zz = ez / dist;
      const xl = Math.hypot(zz, zx) || 1;
      const xx = zz / xl;
      const xz = -zx / xl;
      const yx = zy * xz;
      const yy = zz * xx - zx * xz;
      const yz = -zy * xx;
      const V = cam.view;
      V[0] = xx;
      V[1] = yx;
      V[2] = zx;
      V[3] = 0;
      V[4] = 0;
      V[5] = yy;
      V[6] = zy;
      V[7] = 0;
      V[8] = xz;
      V[9] = yz;
      V[10] = zz;
      V[11] = 0;
      V[12] = -(xx * ex + xz * ez);
      V[13] = -(yx * ex + yy * ey + yz * ez);
      V[14] = -(zx * ex + zy * ey + zz * ez);
      V[15] = 1;
    },
  };
  let x0 = 0;
  let y0 = 0;
  let yaw0 = 0;
  let pitch0 = 0;
  return cam;
}

/** Vertical field of view, radians (38°). */
export const FOV = (38 * Math.PI) / 180;
/** Sphere radius (R). */
export const RADIUS = 1;

/**
 * Camera distance that fits the shape at maximum swell with a 1.32 margin; divided by the aspect
 * ratio when the view is taller than wide, so nothing clips in portrait.
 * @param {number} amp Amplitude param
 * @param {number} aspect width ÷ height
 * @param {number} [extent] the undisplaced shape's reach from the center (default: the sphere)
 */
export function cameraDistance(amp, aspect, extent = RADIUS) {
  const fit = ((extent + amp) * 1.32) / Math.tan(FOV / 2);
  return aspect < 1 ? fit / aspect : fit;
}

/** Fraction of the shorter screen side the track fills at its widest while orbiting. */
export const TRACK_FILL = 0.75;
/** Most of the longer side it may use. */
const TRACK_LONG = 0.9;
/** The self-orbit's pitch sway range (basePitch 0.42 ± 0.3). */
const PITCH_LO = 0.12;
const PITCH_HI = 0.72;

/**
 * Camera distance that frames a Möbius track (see ./track.js): its strip edges at half width W,
 * ± amp along the surface normal, projected over every yaw and the sway's pitch range, fill
 * {@link TRACK_FILL} of the shorter screen side and at most 0.9 of the longer. Exact per point:
 * a point at view coordinates (x, y, z toward the eye) needs dist ≥ z + f·|y| ÷ target.
 * Allocates nothing, but walks the table: call it when Track, Strip width, Amplitude or the
 * aspect ratio change, not every frame.
 * @param {{ data: Float32Array }} track from buildTrack
 * @param {number} W half width @param {number} amp Amplitude param @param {number} aspect
 */
export function fitTrack(track, W, amp, aspect) {
  const d = track.data;
  const K = d.length / 12;
  const f = 1 / Math.tan(FOV / 2);
  const ty = aspect >= 1 ? TRACK_FILL : TRACK_LONG;
  const tx = (aspect >= 1 ? TRACK_LONG : TRACK_FILL) * aspect;
  let dist = 0;
  for (let pi = 0; pi <= 4; pi++) {
    const pitch = PITCH_LO + ((PITCH_HI - PITCH_LO) * pi) / 4;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    for (let yi = 0; yi < 48; yi++) {
      const yaw = (2 * Math.PI * yi) / 48;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      for (let k = 0; k < K; k += 2) {
        const o = k * 4;
        const ot = (K + k) * 4;
        const ow = (2 * K + k) * 4;
        // n = t × w
        const nx = d[ot + 1] * d[ow + 2] - d[ot + 2] * d[ow + 1];
        const ny = d[ot + 2] * d[ow] - d[ot] * d[ow + 2];
        const nz = d[ot] * d[ow + 1] - d[ot + 1] * d[ow];
        for (let e = 0; e < 4; e++) {
          const v = e & 1 ? W : -W;
          const a = e & 2 ? amp : -amp;
          const x = d[o] + v * d[ow] + a * nx;
          const y = d[o + 1] + v * d[ow + 1] + a * ny;
          const z = d[o + 2] + v * d[ow + 2] + a * nz;
          const xv = cy * x - sy * z;
          const yv = -sp * sy * x + cp * y - sp * cy * z;
          const zv = cp * sy * x + sp * y + cp * cy * z;
          const need = zv + (f * Math.max(Math.abs(yv) / ty, Math.abs(xv) / tx));
          if (need > dist) dist = need;
        }
      }
    }
  }
  return dist;
}
