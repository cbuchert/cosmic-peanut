// @ts-check
/** Lattice's param mapping and audio-to-light helpers (pure; nothing allocated per frame). */
import { createFlashLimiter } from "./flash.js";

/** Manifest default of the Speed param. */
export const DEFAULT_SPEED = 1;
/** What Reduce motion uses instead of the default Speed. */
export const REDUCED_SPEED = 0.25;
/** Cells per second at Speed 1. */
export const SPEED_UNIT = 1;
/** Extra speed at the beat envelope's peak, per unit of Reactivity (eased: it follows the envelope). */
export const SURGE = 0.5;

/**
 * Fly speed, cells/s: Speed × SPEED_UNIT plus an eased beat surge. Reduce motion swaps the default
 * Speed for REDUCED_SPEED (a Speed the user picked is respected) and drops the surge.
 * @param {number} speed the Speed param @param {number} env the beat envelope, 0–1
 * @param {number} reactivity the Reactivity param, 0–2 @param {boolean} reduceMotion
 */
export function flySpeed(speed, env, reactivity, reduceMotion) {
  const base = SPEED_UNIT * Math.max(0, reduceMotion && speed === DEFAULT_SPEED ? REDUCED_SPEED : speed);
  const react = Math.max(0, Math.min(2, reactivity));
  return base * (1 + (reduceMotion ? 0 : SURGE * env * react));
}

/** Palette options, in manifest order. */
export const PALETTES = ["steel", "brass", "ink"];
/**
 * Per palette (sRGB hex): background/fog, lattice surface, the rods' axis colours (x = bass,
 * y = mids, z = treble), the beat-pulse light, and whether light is drawn as ink (on paper,
 * light can't be added: pulses and spectra darken toward their colour instead).
 * @type {Record<string, { hex: number[], ink: number }>}
 */
const PALETTE_DEFS = {
  // Cool metallic: blued steel in a dark blue-grey, cold blue / teal / violet light.
  steel: { hex: [0x0a0e14, 0x8a96a8, 0x2f7dff, 0x33e0d0, 0xb47cff, 0xdff4ff], ink: 0 },
  // Warm brass in a dark umber, ember / amber / pale-gold light.
  brass: { hex: [0x120a05, 0xb5873a, 0xff5a1f, 0xffb02e, 0xffe38a, 0xfff1d0], ink: 0 },
  // Ink on paper: a dark lattice on cream, vermilion / indigo / teal inks, red-ink pulses.
  ink: { hex: [0xefe6d2, 0x1e1b1f, 0xb3261e, 0x1f3f8f, 0x1d7a6e, 0x8f1d14], ink: 1 },
};
/** Floats paletteOf writes: six linear RGB colours, then the ink flag. */
export const PALETTE_FLOATS = 19;

/**
 * Write a palette (linear RGB, ≈ sRGB^2.2) into `out`: background, surface, x, y, z, glow, then
 * the ink flag. Unknown names → steel.
 * @param {unknown} name the Palette param @param {Float32Array} out length ≥ PALETTE_FLOATS
 */
export function paletteOf(name, out) {
  const def = PALETTE_DEFS[PALETTES.includes(String(name)) ? String(name) : "steel"];
  for (let i = 0; i < 6; i++) {
    const h = def.hex[i];
    out[i * 3] = (((h >> 16) & 255) / 255) ** 2.2;
    out[i * 3 + 1] = (((h >> 8) & 255) / 255) ** 2.2;
    out[i * 3 + 2] = ((h & 255) / 255) ** 2.2;
  }
  out[18] = def.ink;
  return out;
}

/** Quality options: render scale of the raymarch pass (a composite upsamples it) and its step budget. */
export const QUALITIES = ["low", "medium", "high"];
/** @type {Record<string, { scale: number, steps: number }>} */
const QUALITY = {
  low: { scale: 0.5, steps: 56 },
  medium: { scale: 0.67, steps: 80 },
  high: { scale: 0.85, steps: 110 },
};
/** @param {unknown} name the Quality param → its settings (unknown → medium) */
export function qualityOf(name) {
  return QUALITY[QUALITIES.includes(String(name)) ? String(name) : "medium"];
}

/** The Rod thickness param (rod radius, cells). */
export const THICKNESS = { min: 0.03, max: 0.12, default: 0.06 };

/**
 * Rod radius, cube half-size and cube corner rounding (cells) for a Rod thickness, into `out`.
 * The cubes grow with the rods but stay inside 0.5 cell of their node even at the corners, so
 * the camera's channel (≥ 0.6 from nodes) stays clear.
 * @param {number} thickness @param {Float32Array} out length ≥ 3
 */
export function geometry(thickness, out) {
  const rod = Math.max(THICKNESS.min, Math.min(THICKNESS.max, Number(thickness) || THICKNESS.default));
  const half = 0.1 + 1.4 * rod;
  out[0] = rod;
  out[1] = half;
  out[2] = 0.35 * half;
  return out;
}

/** Fog density per cell for the Fog param (0–1): a faint haze at 0, thick at 1. */
export function fogDensity(/** @type {number} */ fog) {
  return 0.015 + 0.15 * Math.max(0, Math.min(1, fog));
}

/** The bands (of 64) behind each axis's light: x bass, y mids, z treble. */
const AXIS_BANDS = [0, 16, 40, 64];
/** Seconds of the slow average each axis is measured against (auto-gain), and its floor. */
const AXIS_AVG_TAU = 4;
const AXIS_FLOOR = 0.02;
/** Seconds per easing stage (two stages: no snap). */
const AXIS_TAU = 0.1;
/** Under Reduce flashing the axis light is scaled by this (and limited to 3 rises a second). */
export const REDUCED_AXIS = 0.35;

/**
 * The rods' light per axis from the spectrum: each axis's bands against their own slow average
 * (so a quiet treble still lights the z rods), 0–1 at Reactivity 1 (0.5 for a steady level),
 * eased through two stages and passed through the flash limiter — it reaches every rod of an axis
 * at once, so it counts as full-screen brightness.
 */
export function createAxisLight() {
  const avg = new Float32Array(3);
  const mid = new Float32Array(3);
  const eased = new Float32Array(3);
  const limit = [createFlashLimiter(), createFlashLimiter(), createFlashLimiter()];
  const a = {
    /** x, y, z light, 0–Reactivity. */
    light: new Float32Array(3),
    /**
     * @param {Float32Array} bands `audio.bands` @param {number} dt @param {number} reactivity
     * @param {boolean} reduceFlashing
     */
    step(bands, dt, reactivity, reduceFlashing) {
      const react = Math.max(0, Math.min(2, reactivity));
      const ka = 1 - Math.exp(-dt / AXIS_AVG_TAU);
      const k = 1 - Math.exp(-dt / AXIS_TAU);
      const n = bands.length;
      for (let x = 0; x < 3; x++) {
        const lo = Math.floor((AXIS_BANDS[x] * n) / 64);
        const hi = Math.max(lo + 1, Math.floor((AXIS_BANDS[x + 1] * n) / 64));
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        e /= hi - lo;
        avg[x] += (e - avg[x]) * ka;
        const ratio = Math.min(2, e / (avg[x] + AXIS_FLOOR));
        mid[x] += ((react * ratio) / 2 - mid[x]) * k;
        eased[x] += (mid[x] - eased[x]) * k;
        a.light[x] = limit[x].step((reduceFlashing ? REDUCED_AXIS : 1) * eased[x], dt, reduceFlashing);
      }
      return a;
    },
  };
  return a;
}

/** Under Reduce motion: how fast the rods' running light goes, and how far beat pulses travel. */
export const REDUCED_MOTION = 0.3;
/** @param {boolean} reduceMotion `ctx.reduceMotion` */
export function motionScale(reduceMotion) {
  return reduceMotion ? REDUCED_MOTION : 1;
}
