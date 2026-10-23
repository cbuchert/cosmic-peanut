// @ts-check
/** Möbius Field: the bands' layout in a box that wraps around the flying camera. */
import { FLY_FOV } from "./fly.js";

/** Most a band's centre strays from its cell's centre, in cells. */
export const JITTER = 0.3;

/** Band scale range. */
export const SCALE = [0.55, 0.95];
/** Spin speed range about the band's own axis, rad/s (either way). */
export const SPIN = [0.04, 0.16];
/** Most palette shift per band. */
export const HUE = 0.08;

/** Bands start fading into the fog at this fraction of the Fog distance (gone at 1). */
export const FOG_START = 0.5;
/** Near fade, in band radii from the camera: gone at NEAR[0], full at NEAR[1]. */
export const NEAR = [1.2, 3];
/** The box's half side, in Fog distances: bands are black for the last stretch before they wrap. */
export const BOX = 1.1;
/** Floats per instance: offset xyz, fade | quaternion xyzw | scale, row offset, hue, wring side. */
export const INST = 12;

/** Seeded PRNG (mulberry32): the same seed always lays out the same field. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` bands, each in its own cell of the smallest n × n × n grid over the unit box that holds
 * them (cells picked at random), jittered by up to {@link JITTER} of a cell, each with its own
 * random orientation, size, spin, history offset, hue and wring side. Allocates; call on a Bands
 * change only.
 * @param {number} count @param {number} seed
 */
export function createLayout(count, seed) {
  const n = Math.max(1, Math.ceil(Math.cbrt(count) - 1e-9));
  const rand = rng(seed);
  // A seeded shuffle of the cells; the first `count` get a band.
  const cells = new Int32Array(n * n * n);
  for (let i = 0; i < cells.length; i++) cells[i] = i;
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = cells[i];
    cells[i] = cells[j];
    cells[j] = t;
  }
  const unit = new Float32Array(count * 3);
  const quat = new Float32Array(count * 4);
  const scale = new Float32Array(count);
  const spin = new Float32Array(count);
  const offset = new Float32Array(count);
  const hue = new Float32Array(count);
  const side = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const c = cells[k];
    const cell = [c % n, Math.floor(c / n) % n, Math.floor(c / (n * n))];
    for (let d = 0; d < 3; d++) unit[k * 3 + d] = (cell[d] + 0.5 + JITTER * (2 * rand() - 1)) / n;
    // Uniform random rotation (Shoemake).
    const u1 = rand();
    const u2 = 2 * Math.PI * rand();
    const u3 = 2 * Math.PI * rand();
    const a = Math.sqrt(1 - u1);
    const b = Math.sqrt(u1);
    quat[k * 4] = a * Math.sin(u2);
    quat[k * 4 + 1] = a * Math.cos(u2);
    quat[k * 4 + 2] = b * Math.sin(u3);
    quat[k * 4 + 3] = b * Math.cos(u3);
    scale[k] = SCALE[0] + (SCALE[1] - SCALE[0]) * rand();
    const r = rand();
    spin[k] = (SPIN[0] + (SPIN[1] - SPIN[0]) * r) * (rand() < 0.5 ? -1 : 1);
    offset[k] = rand();
    hue[k] = HUE * (2 * rand() - 1);
    side[k] = rand() < 0.5 ? -1 : 1;
  }
  return { n, count, unit, quat, scale, spin, offset, hue, side };
}

/**
 * A band's brightness factor (0–1) for its centre's distance from the camera.
 * @param {number} dist @param {number} radius the band's reach @param {number} fog Fog distance
 */
export function bandFade(dist, radius, fog) {
  const near = smooth((dist - NEAR[0] * radius) / ((NEAR[1] - NEAR[0]) * radius));
  return near * (1 - smooth((dist - FOG_START * fog) / ((1 - FOG_START) * fog)));
}

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

const TAU = 2 * Math.PI;

/** x wrapped into [−S/2, S/2). @param {number} x @param {number} S */
const wrap = (x, S) => x - S * Math.floor(x / S + 0.5);


/**
 * The bands in a box of side 2 × BOX × Fog, centred on the camera and wrapping: each band's
 * offset from the camera is taken modulo the box, so a band that falls behind reappears on the
 * far side, where the fog hides it ({@link bandFade} is 0 from the Fog distance on, and a wrap
 * happens no nearer than BOX × Fog). Positions are world space in float64; the GPU only ever sees
 * offsets from the camera, so precision never degrades however far it flies. `place`, `spin` and
 * `pack` allocate nothing; `setFog` (a param change) stretches the field about the camera.
 * @param {number} count bands ({@link fieldCount}) @param {number} seed @param {number} fog
 */
export function createField(count, seed, fog) {
  const layout = createLayout(count, seed);
  let S = 2 * BOX * fog;
  const pos = new Float64Array(layout.count * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = layout.unit[i] * S;
  const f = {
    layout,
    count: layout.count,
    /** Each band's offset from the camera, wrapped into the box. */
    rel: new Float32Array(layout.count * 3),
    /** Each band's fade (fog and near), from its offset. */
    fade: new Float32Array(layout.count),
    /** Each band's spin angle about its own axis, radians. */
    angle: new Float32Array(layout.count),
    /** The visible bands' instance data, {@link INST} floats each (first `pack()` of them). */
    inst: new Float32Array(layout.count * INST),
    /**
     * Write the bands that are lit and at least partly in view (bounding sphere of radius
     * reach × scale against the frustum) into `inst`, compacted.
     * @param {Float32Array} view rotation-only view matrix @param {number} tanX @param {number} tanY
     * @param {number} reach a band's bounding radius at scale 1 @param {number} rows most history
     *   rows a band lags behind ({@link rowLag}); each band's offset is its share of that
     * @returns {number} instances written
     */
    pack(view, tanX, tanY, reach, rows) {
      const { quat, scale, offset, hue, side } = layout;
      const secX = Math.sqrt(1 + tanX * tanX);
      const secY = Math.sqrt(1 + tanY * tanY);
      const out = f.inst;
      let n = 0;
      for (let k = 0; k < f.count; k++) {
        if (f.fade[k] <= 0) continue;
        const x = f.rel[k * 3];
        const y = f.rel[k * 3 + 1];
        const z = f.rel[k * 3 + 2];
        // View space (rotation only: the camera sits at the origin of the offsets).
        const vx = view[0] * x + view[4] * y + view[8] * z;
        const vy = view[1] * x + view[5] * y + view[9] * z;
        const depth = -(view[2] * x + view[6] * y + view[10] * z);
        const r = reach * scale[k];
        if (depth <= -r) continue;
        if (Math.abs(vx) > depth * tanX + r * secX || Math.abs(vy) > depth * tanY + r * secY) continue;
        const o = n * INST;
        out[o] = x;
        out[o + 1] = y;
        out[o + 2] = z;
        out[o + 3] = f.fade[k];
        // Orientation, then the spin about the band's own axis (local y): q ⊗ (0, sin ½a, 0, cos ½a).
        const s = Math.sin(f.angle[k] / 2);
        const c = Math.cos(f.angle[k] / 2);
        const qx = quat[k * 4];
        const qy = quat[k * 4 + 1];
        const qz = quat[k * 4 + 2];
        const qw = quat[k * 4 + 3];
        out[o + 4] = qx * c - qz * s;
        out[o + 5] = qw * s + qy * c;
        out[o + 6] = qz * c + qx * s;
        out[o + 7] = qw * c - qy * s;
        out[o + 8] = scale[k];
        out[o + 9] = Math.floor(offset[k] * rows);
        out[o + 10] = hue[k];
        out[o + 11] = side[k];
        n++;
      }
      return n;
    },
    /** Advance every band's spin. @param {number} dt seconds */
    spin(dt) {
      for (let k = 0; k < f.count; k++) {
        const a = f.angle[k] + layout.spin[k] * dt;
        f.angle[k] = a - TAU * Math.floor(a / TAU);
      }
    },
    /** Stretch the field about the camera for a new Fog. @param {number} next @param {ArrayLike<number>} cam */
    setFog(next, cam) {
      const S2 = 2 * BOX * next;
      for (let k = 0; k < f.count; k++) {
        for (let d = 0; d < 3; d++) {
          pos[k * 3 + d] = cam[d] + wrap(pos[k * 3 + d] - cam[d], S) * (S2 / S);
        }
      }
      S = S2;
      fog = next;
    },
    /**
     * Each band's offset from the camera, wrapped into the box, and its fade.
     * @param {ArrayLike<number>} cam camera position @param {number} reach as for `pack`
     */
    place(cam, reach) {
      for (let k = 0; k < f.count; k++) {
        let d2 = 0;
        for (let d = 0; d < 3; d++) {
          const r = wrap(pos[k * 3 + d] - cam[d], S);
          f.rel[k * 3 + d] = r;
          d2 += r * r;
        }
        f.fade[k] = bandFade(Math.sqrt(d2), reach * layout.scale[k], fog);
      }
    },
  };
  return f;
}

/**
 * Share of the box inside the view out to the Fog distance at 16:9: the solid angle of the
 * frustum, 4·asin(sin a · sin b) for half angles a and b, times Fog³ ÷ 3, over the box's volume.
 * It doesn't depend on Fog, so neither does how many bands are in view.
 */
const HALF_Y = FLY_FOV / 2;
const HALF_X = Math.atan(Math.tan(HALF_Y) * (16 / 9));
export const VIEW_SHARE = (4 * Math.asin(Math.sin(HALF_X) * Math.sin(HALF_Y))) / 3 / (2 * BOX) ** 3;

/**
 * Bands in the box for about `bands` band centres in view. Most of them are behind or beside the
 * camera, where they cost nothing: `pack` skips them.
 * @param {number} bands the Bands param
 */
export function fieldCount(bands) {
  return Math.round(bands / VIEW_SHARE);
}

/**
 * Most history rows a band lags behind the newest ring, so neighbours show different moments.
 * Each band draws N − rowLag(N) slices, so however far it lags its oldest is still in the history.
 * @param {number} N history rows
 */
export function rowLag(N) {
  return Math.floor(N / 8);
}
