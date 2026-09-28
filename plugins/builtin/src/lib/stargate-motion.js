// @ts-check
/** Stargate's motion: camera roll, travel-speed surges, flash-limited global intensity. */
import { createFlashLimiter } from "./flash.js";

/** How much the roll rate breathes with the bass: ±BREATH of the set rate at bassAtt 0 / 2. */
export const BREATH = 0.35;
/** Time constant (s) of the bass level that drives the breathing, so the roll never jerks. */
const BREATH_TAU = 0.8;

/**
 * Camera roll about the direction of travel. The angle integrates the user's rate (rad/s), scaled
 * by 1 ± BREATH following a slowly smoothed bassAtt (1 = average bass = exactly the set rate).
 */
export function createRoll() {
  const r = {
    /** Radians. */
    angle: 0,
    /** Smoothed bassAtt, clamped to 0–2. */
    bass: 1,
    /**
     * @param {number} dt seconds
     * @param {number} rate rad/s (negative rolls the other way)
     * @param {number} bassAtt `audio.bassAtt`
     * @returns {number} the new angle
     */
    step(dt, rate, bassAtt) {
      const b = Math.min(2, Math.max(0, bassAtt || 0));
      r.bass += (b - r.bass) * (1 - Math.exp(-dt / BREATH_TAU));
      r.angle += rate * (1 + BREATH * (r.bass - 1)) * dt;
      return r.angle;
    },
  };
  return r;
}

/** Manifest defaults of the Roll (rad/s) and Speed params. */
export const DEFAULT_ROLL = 0.25;
export const DEFAULT_SPEED = 1;
/** Used instead of the defaults when macOS "Reduce motion" is on. */
export const REDUCED_ROLL = 0.05;
export const REDUCED_SPEED = 0.5;

/**
 * The roll and speed to use this frame. With Reduce motion on, params still at their defaults get
 * gentler values; anything the user chose is respected.
 * @param {number} roll Roll param, rad/s
 * @param {number} speed Speed param
 * @param {boolean} reduceMotion `ctx.reduceMotion`
 * @param {{ roll: number, speed: number }} out
 */
export function effectiveMotion(roll, speed, reduceMotion, out) {
  out.roll = reduceMotion && roll === DEFAULT_ROLL ? REDUCED_ROLL : roll;
  out.speed = reduceMotion && speed === DEFAULT_SPEED ? REDUCED_SPEED : speed;
  return out;
}

/** Most a bass surge can add to the travel speed (×(1 + SURGE_MAX)). */
export const SURGE_MAX = 0.8;
/** Surge per unit of bassAtt above average. */
const SURGE_GAIN = 0.8;
const SURGE_ATTACK = 0.12;
const SURGE_RELEASE = 0.7;

/**
 * Travel-speed multiplier from the bass: 1 at or below average bass (bassAtt ≤ 1), rising with a
 * short attack on heavier bass, bounded at 1 + SURGE_MAX, and easing back with a long release so a
 * surge reads as a push forward, never a jolt.
 */
export function createSurge() {
  let v = 0;
  return {
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @returns {number} speed multiplier, 1 to 1 + SURGE_MAX
     */
    step(bassAtt, dt) {
      const target = Math.min(SURGE_MAX, Math.max(0, ((bassAtt || 0) - 1) * SURGE_GAIN));
      const tau = target > v ? SURGE_ATTACK : SURGE_RELEASE;
      v += (target - v) * (1 - Math.exp(-dt / tau));
      return 1 + v;
    },
  };
}

/** Most an onset brightens the whole frame (×(1 + PULSE)). */
export const PULSE = 0.35;

/**
 * Whole-frame brightness from onsets: a kick envelope (sized by onset strength and the bass)
 * through the shared flash limiter, so with `reduceFlashing` it swings at most 3 times a second.
 */
export function createIntensity() {
  const flash = createFlashLimiter();
  let kick = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @returns {number} brightness multiplier, 1 to 1 + PULSE
     */
    step(onset, onsetStrength, bassAtt, dt, reduceFlashing) {
      const b = Math.min(2, Math.max(0, bassAtt || 0)) / 2;
      kick = onset ? Math.min(1, (0.3 + 0.7 * Math.min(1, onsetStrength)) * (0.5 + 0.5 * b)) : kick * Math.exp(-dt * 6);
      return 1 + PULSE * flash.step(kick, dt, reduceFlashing);
    },
  };
}

/** Seconds between solarized moments, at least. */
export const SOLAR_COOLDOWN = 8;
const SOLAR_RISE = 0.35;
const SOLAR_HOLD = 0.5;
const SOLAR_FALL = 0.6;

/**
 * The film's colour-inverted moments: a big hit (strong onset on heavy bass) starts a moment that
 * ramps in over SOLAR_RISE s, holds, and ramps out, at most once per SOLAR_COOLDOWN. The amount
 * (0–1) also goes through a flash limiter: it changes the whole frame.
 */
export function createSolar() {
  const flash = createFlashLimiter();
  let since = Infinity; // seconds since the current/last moment started
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @returns {number} solarize amount, 0–1
     */
    step(onset, onsetStrength, bassAtt, dt, reduceFlashing) {
      since += dt;
      if (onset && onsetStrength >= 0.6 && bassAtt >= 1.4 && since >= SOLAR_COOLDOWN) since = 0;
      let v = 0;
      if (since < SOLAR_RISE) v = since / SOLAR_RISE;
      else if (since < SOLAR_RISE + SOLAR_HOLD) v = 1;
      else if (since < SOLAR_RISE + SOLAR_HOLD + SOLAR_FALL) v = 1 - (since - SOLAR_RISE - SOLAR_HOLD) / SOLAR_FALL;
      return flash.step(v, dt, reduceFlashing);
    },
  };
}
