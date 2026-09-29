// @ts-check
/**
 * Eclipse's pure logic (allocation-free per step): the corona's circular spectrogram, the ring's
 * bass response, beat flares, flash-limited brightness, tint/sky selection, layout and motion.
 * GPU side: shaders/eclipse/.
 */

import { createSpectroGain, logColumns, resampleSpectrum } from "./spectro.js";

/** Angular sectors in the corona level texture (one full turn). */
export const SECTORS = 256;

/** Frequency range of the corona (Hz): bottom → top. */
export const F_MIN = 30;
export const F_MAX = 16000;

/** Level smoothing time constants (s): tendrils burst out quickly and recede organically. */
export const ATTACK = 0.05;
export const RELEASE = 0.35;

/**
 * The corona's circular spectrogram. Sector i sits at angle
 *   a = ((i + 0.5) / count − 0.5) · 2π   (0 = straight down, +π/2 = right, ±π = top),
 * the shader's `atan(p.x, −p.y)`. Frequencies run on a log axis from fMin at the bottom to fMax at
 * the top, mirrored left/right. Levels are spectro.js dB levels (gate + slow per-frequency
 * auto-gain) smoothed with ATTACK / RELEASE, 0–1.
 * @param {number} [count]
 */
export function createCorona(count = SECTORS) {
  const lo = new Float32Array(count);
  const hi = new Float32Array(count);
  const mags = new Float32Array(count);
  const raw = new Float32Array(count);
  const levels = new Float32Array(count);
  logColumns("mirrored", F_MIN, F_MAX, lo, hi);
  const gain = createSpectroGain(count);
  gain.setTilt(lo, hi);
  return {
    lo,
    hi,
    levels,
    /**
     * @param {ArrayLike<number>} spectrum
     * @param {number} sampleRate
     * @param {number} dt
     */
    step(spectrum, sampleRate, dt) {
      resampleSpectrum(spectrum, sampleRate, lo, hi, mags);
      gain.step(mags, dt, raw);
      const ka = 1 - Math.exp(-dt / ATTACK);
      const kr = 1 - Math.exp(-dt / RELEASE);
      for (let i = 0; i < count; i++) {
        const d = raw[i] - levels[i];
        levels[i] += d * (d > 0 ? ka : kr);
      }
    },
  };
}

/** Radius of the black disc at rest, in units of the composition radius (fitEclipse). */
export const DISC = 0.3;

/** Annulus width at rest (Ring thickness 1). */
export const RING = 0.12;
/** At full bass the disc shrinks by this fraction and the annulus widens by this fraction. */
const BASS_SHRINK = 0.06;
const BASS_WIDEN = 0.35;
/** Bass envelope time constants (s): the sun pushes back smoothly, and relaxes slower. */
const SWELL_ATTACK = 0.12;
const SWELL_RELEASE = 0.4;

/**
 * The ring's response to the bass. `swell` (0–1) follows `bassAtt` (≈1 = average) above half
 * the average, × Reactivity, smoothed; the disc shrinks and the annulus widens with it.
 * Radii are in composition units (the fit radius = 1).
 */
export function createRing() {
  const r = {
    disc: DISC,
    outer: DISC + RING,
    /** Smoothed bass drive 0–1: ring glow, thickness, disc shrink. */
    swell: 0,
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} thickness Ring thickness param (× RING)
     */
    step(bassAtt, dt, reactivity, thickness) {
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      const x = ((bassAtt - 0.5) / 1.5) * react;
      const target = x > 0 ? (x < 1 ? x : 1) : 0; // NaN → 0
      const tau = target > r.swell ? SWELL_ATTACK : SWELL_RELEASE;
      r.swell += (target - r.swell) * (1 - Math.exp(-dt / tau));
      const th = thickness > 0 ? thickness : 0;
      r.disc = DISC * (1 - BASS_SHRINK * r.swell);
      r.outer = r.disc + RING * th * (1 + BASS_WIDEN * r.swell);
    },
  };
  return r;
}
