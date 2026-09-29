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
export const BEAM_WIDTH = [1, 2.2];
export const BEAM_BRIGHT = [0.55, 1];
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
