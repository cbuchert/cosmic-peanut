// @ts-check
/**
 * Dark Sun's pure logic, tested in darksun.test.js: the sun's rim and corona, the travelling
 * diamond ring, the beam, the flash-limited surge, layout, palettes and Reduce-motion defaults.
 * Every `step` is frame-rate independent and allocates nothing.
 */
import { createFlashLimiter } from "./flash.js";

/** Rim glow (multiplier) and corona reach (in sun radii past the rim) at rest and at full swell. */
export const RIM_MIN = 0.5;
export const RIM_MAX = 1;
export const REACH_MIN = 0.6;
export const REACH_MAX = 1.6;
/** Time constant (s) of the sun's swell: bass breathes it, kicks never pop it. */
const SUN_TAU = 0.25;

/** Clamp to 0–hi; NaN → 0. @param {number} v @param {number} hi */
const clamp = (v, hi) => (v > 0 ? (v < hi ? v : hi) : 0);

/**
 * The sun's swell from `audio.bassAtt` (1 = average bass): drive = reactivity · 0.4 · bassAtt,
 * capped at 1, smoothed with SUN_TAU. Reactivity 0 leaves the sun at rest.
 */
export function createSun() {
  const s = {
    /** 0–1 smoothed swell. */
    level: 0,
    rim: RIM_MIN,
    reach: REACH_MIN,
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @returns {number} the swell, 0–1
     */
    step(bassAtt, dt, reactivity) {
      const drive = clamp(0.4 * clamp(reactivity, 2) * clamp(bassAtt, 3), 1);
      s.level += (drive - s.level) * (1 - Math.exp(-dt / SUN_TAU));
      s.rim = RIM_MIN + (RIM_MAX - RIM_MIN) * s.level;
      s.reach = REACH_MIN + (REACH_MAX - REACH_MIN) * s.level;
      return s.level;
    },
  };
  return s;
}

/** Diamond ring's travel (rad/s) at rest; energy adds up to DIAMOND_BOOST × that. */
export const DIAMOND_RATE = 0.12;
const DIAMOND_BOOST = 1;
/** Where it starts (rad, counter-clockwise from +x, y up): low on the right, like the cover. */
export const DIAMOND_START = -0.85;

/**
 * The brightest point on the rim, travelling slowly around it. Energy (e.g. `audio.bassAtt`,
 * 1 = average) is clamped to 0–2 and smoothed over half a second, then speeds it by up to
 * DIAMOND_BOOST; `motion` scales the whole rate (Reduce motion halves it).
 */
export function createDiamond() {
  const d = {
    /** Radians, unwrapped. */
    angle: DIAMOND_START,
    energy: 0,
    /**
     * @param {number} energy
     * @param {number} dt seconds
     * @param {number} motion rate scale, ≥ 0
     */
    step(energy, dt, motion) {
      d.energy += (clamp(energy, 2) / 2 - d.energy) * (1 - Math.exp(-dt / 0.5));
      d.angle += DIAMOND_RATE * (1 + DIAMOND_BOOST * d.energy) * clamp(motion, 4) * dt;
      return d.angle;
    },
  };
  return d;
}

/** Beam width (multiplier of its base width) and brightness, [rest, full]. */
export const BEAM_WIDTH = [1, 3];
export const BEAM_BRIGHT = [0.35, 1];
/** The beam's pulse follows its drive with a quick attack and an easy release (s). */
const BEAM_ATTACK = 0.03;
const BEAM_RELEASE = 0.3;

/**
 * The narrow light falling from the range's centre. Drive = reactivity · (0.35 · bass + 1.5 · rms)
 * (bass is `audio.bass`, 1 = average; rms is `audio.rms`), capped at 1.
 */
export function createBeam() {
  const b = {
    level: 0,
    width: BEAM_WIDTH[0],
    bright: BEAM_BRIGHT[0],
    /**
     * @param {number} bass `audio.bass`
     * @param {number} rms `audio.rms`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(bass, rms, dt, reactivity) {
      const drive = clamp(clamp(reactivity, 2) * (0.35 * clamp(bass, 3) + 1.5 * clamp(rms, 1)), 1);
      const tau = drive > b.level ? BEAM_ATTACK : BEAM_RELEASE;
      b.level += (drive - b.level) * (1 - Math.exp(-dt / tau));
      b.width = BEAM_WIDTH[0] + (BEAM_WIDTH[1] - BEAM_WIDTH[0]) * b.level;
      b.bright = BEAM_BRIGHT[0] + (BEAM_BRIGHT[1] - BEAM_BRIGHT[0]) * b.level;
      return b.level;
    },
  };
  return b;
}

/** Surge decay rate (1/s): a beat's flare is mostly gone in half a second. */
const SURGE_DECAY = 7;

/**
 * Beat flare for the beam and the horizon glow (a full-width brightness change, so it goes through
 * the shared flash limiter): an onset lifts the envelope to 0.5 + 0.5 · strength, which then decays
 * at SURGE_DECAY. With `reduceFlashing` at most 3 new flares start per second.
 */
export function createSurge() {
  const flash = createFlashLimiter();
  let env = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @returns {number} 0–1
     */
    step(onset, strength, dt, reduceFlashing) {
      env *= Math.exp(-dt * SURGE_DECAY);
      if (onset) {
        const k = 0.5 + 0.5 * clamp(strength, 1);
        if (k > env) env = k;
      }
      return flash.step(env, dt, reduceFlashing);
    },
  };
}

/**
 * @typedef {object} Layout drawing-buffer pixels, y down from the top
 * @property {number} horizon y of the horizon line
 * @property {number} sunX
 * @property {number} sunY
 * @property {number} sunR disc radius
 * @property {number} rangeHalf half-width of the inverted range
 * @property {number} rangeDepth depth of a full-level peak below the horizon
 * @property {number} beamWidth the beam's base half-width
 * @property {number} unit min(w, h)
 */

/**
 * The cover's composition, scaled by min(w, h) so it holds in landscape, portrait and small
 * windows: horizon at half height; the sun centred at 22 % from the top (lower if its corona would
 * clip the top edge); the range centred, `rangeWidth` of the width across, hanging up to
 * 0.28 · min(w, h) · rangeDepth (typical levels sit well under 1) (never more than 80 % of the way to the bottom).
 * @param {number} w
 * @param {number} h
 * @param {{ sunSize: number, rangeWidth: number, rangeDepth: number }} o
 * @param {Layout} out
 * @returns {Layout}
 */
export function layout(w, h, o, out) {
  const unit = Math.min(w, h);
  const horizon = 0.5 * h;
  const r = 0.085 * unit * o.sunSize;
  out.unit = unit;
  out.horizon = horizon;
  out.sunX = 0.5 * w;
  out.sunR = r;
  out.sunY = Math.max(0.22 * h, 1.2 * r);
  out.rangeHalf = 0.5 * o.rangeWidth * w;
  out.rangeDepth = Math.min(0.28 * unit * o.rangeDepth, 0.8 * (h - horizon));
  out.beamWidth = 0.004 * unit;
  return out;
}

/** Manifest defaults and ranges of the number params (tests/test_builtin_manifests.py pins them). */
export const DEFAULTS = { reactivity: 1, rangeWidth: 0.5, rangeDepth: 1, beam: 1, sunSize: 1 };
/** @type {Record<keyof typeof DEFAULTS, [number, number]>} */
export const RANGES = {
  reactivity: [0, 2],
  rangeWidth: [0.3, 0.7],
  rangeDepth: [0.3, 2],
  beam: [0, 2],
  sunSize: [0.5, 1.6],
};
const KEYS = /** @type {(keyof typeof DEFAULTS)[]} */ (Object.keys(DEFAULTS));
/** Under Reduce motion: drift/rotation scale, and the reactivity used while it's at its default. */
export const REDUCED_MOTION = 0.4;
export const REDUCED_REACTIVITY = 0.6;

/**
 * @typedef {object} Resolved
 * @property {number} reactivity
 * @property {number} rangeWidth
 * @property {number} rangeDepth
 * @property {number} beam
 * @property {number} sunSize
 * @property {number} motion scale for every slow drift and rotation
 */

/**
 * Number params clamped to their ranges (NaN → default), plus a motion scale. Reduce motion slows
 * all drift and, while Reactivity sits at its default, softens it; a value the user chose stays.
 * @param {Readonly<Record<string, unknown>>} p `ctx.params`
 * @param {boolean} reduceMotion
 * @param {Resolved} out
 */
export function resolveParams(p, reduceMotion, out) {
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i];
    const v = Number(p[k]);
    const [lo, hi] = RANGES[k];
    out[k] = Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : DEFAULTS[k];
  }
  out.motion = reduceMotion ? REDUCED_MOTION : 1;
  if (reduceMotion && out.reactivity === DEFAULTS.reactivity) out.reactivity = REDUCED_REACTIVITY;
  return out;
}

/** Colour slots of a palette (vec3 each), in order. */
const SLOTS = ["SKY_TOP", "SKY_LOW", "GROUND", "WASH", "GLOW", "RIM", "DISC", "CORONA"];
/** @type {Record<string, number[][]>} same order as SLOTS */
const TABLE = {
  // The cover: ash-grey sky over salmon, dark mauve-brown ground, near-white light.
  dusk: [
    [0.3, 0.3, 0.32],
    [0.93, 0.5, 0.52],
    [0.16, 0.115, 0.115],
    [0.34, 0.25, 0.25],
    [1, 0.93, 0.92],
    [1, 0.88, 0.86],
    [0.07, 0.06, 0.065],
    [0.85, 0.36, 0.36],
  ],
  ash: [[0.29, 0.29, 0.29], [0.62, 0.62, 0.62], [0.12, 0.12, 0.12], [0.26, 0.26, 0.26], [0.97, 0.97, 0.97], [0.95, 0.95, 0.95], [0.06, 0.06, 0.06], [0.6, 0.6, 0.6]],
  teal: [[0.16, 0.22, 0.26], [0.45, 0.78, 0.78], [0.06, 0.12, 0.13], [0.14, 0.26, 0.27], [0.88, 1, 0.98], [0.85, 1, 0.97], [0.04, 0.07, 0.08], [0.3, 0.7, 0.7]],
  gold: [[0.3, 0.26, 0.22], [0.96, 0.7, 0.4], [0.16, 0.11, 0.07], [0.33, 0.23, 0.15], [1, 0.95, 0.84], [1, 0.92, 0.75], [0.07, 0.05, 0.04], [0.9, 0.55, 0.25]],
};

/** Palette names (manifest order) and slot indices (vec3 index into a palette buffer). */
export const PALETTES = {
  names: Object.keys(TABLE),
  SIZE: SLOTS.length * 3,
  SKY_TOP: 0,
  SKY_LOW: 1,
  GROUND: 2,
  WASH: 3,
  GLOW: 4,
  RIM: 5,
  DISC: 6,
  CORONA: 7,
};

/**
 * Fill `out` (PALETTES.SIZE floats, 0–1) with a palette's colours; unknown names → dusk.
 * @param {unknown} name
 * @param {Float32Array} out
 */
export function palette(name, out) {
  const t = TABLE[typeof name === "string" && Object.hasOwn(TABLE, name) ? name : "dusk"];
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = t[i][c];
  return out;
}

/** Backdrop "none" leaves sky and ground transparent; anything else paints them. @param {unknown} b */
export function isPainted(b) {
  return b !== "none";
}

/** Horizon glow at rest and at full breath; a surge adds up to 0.5 on top. */
export const GLOW_RANGE = [0.5, 1];
/** Breathing time constant (s). */
const GLOW_TAU = 0.4;

/**
 * The horizon glow: breathes with `audio.midAtt` (1 = average; drive = reactivity · 0.5 · midAtt,
 * capped at 1, smoothed over GLOW_TAU), plus half the surge, which the caller has already passed
 * through the flash limiter.
 */
export function createGlow() {
  const g = {
    level: 0,
    value: GLOW_RANGE[0],
    /**
     * @param {number} midAtt `audio.midAtt`
     * @param {number} surge 0–1, flash-limited
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(midAtt, surge, dt, reactivity) {
      const drive = clamp(0.5 * clamp(reactivity, 2) * clamp(midAtt, 3), 1);
      g.level += (drive - g.level) * (1 - Math.exp(-dt / GLOW_TAU));
      g.value = GLOW_RANGE[0] + (GLOW_RANGE[1] - GLOW_RANGE[0]) * g.level + 0.5 * clamp(surge, 1);
      return g.value;
    },
  };
  return g;
}
