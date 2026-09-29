// @ts-check
/**
 * Eclipse's pure logic (allocation-free per step): the corona's circular spectrogram, the ring's
 * bass response, beat flares, flash-limited brightness, tint/sky selection, layout and motion.
 * GPU side: shaders/eclipse/.
 */

import { createFlashLimiter } from "./flash.js";
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

/** Flare pool size (uniform vec2 array length in the shader). */
export const FLARES = 4;

/** Flare travel speed (composition units/s), amplitude decay (s), and where it's gone. */
const FLARE_SPEED = 0.5;
const FLARE_DECAY = 0.45;
const FLARE_END = 1;
const FLARE_MIN = 0.02;

/**
 * Beat flares: each onset launches a ring of extra brightness from the ring's outer edge that
 * travels outward through the corona and fades. `data` holds FLARES × (radius past the ring's
 * outer edge, amplitude 0–1); amplitude 0 = free slot. A new onset takes a free slot, else the
 * oldest (farthest) flare's.
 */
export function createFlares() {
  const data = new Float32Array(2 * FLARES);
  return {
    data,
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength` (≈0–1)
     * @param {number} dt seconds
     * @param {number} reactivity 0–2 (amplitude × min(1, reactivity))
     */
    step(onset, strength, dt, reactivity) {
      const fade = Math.exp(-dt / FLARE_DECAY);
      for (let i = 0; i < FLARES; i++) {
        if (data[2 * i + 1] <= 0) continue;
        data[2 * i] += FLARE_SPEED * dt;
        data[2 * i + 1] *= fade;
        if (data[2 * i + 1] < FLARE_MIN || data[2 * i] > FLARE_END) data[2 * i] = data[2 * i + 1] = 0;
      }
      if (!onset) return;
      const s = strength > 0 ? (strength < 1 ? strength : 1) : 0;
      const react = reactivity > 0 ? (reactivity < 1 ? reactivity : 1) : 0;
      const amp = (0.35 + 0.65 * s) * react;
      if (amp < FLARE_MIN) return;
      let slot = 0;
      for (let i = 0; i < FLARES; i++) {
        if (data[2 * i + 1] <= 0) {
          slot = i;
          break;
        }
        if (data[2 * i] > data[2 * slot]) slot = i;
      }
      data[2 * slot] = 0;
      data[2 * slot + 1] = amp;
    },
  };
}

/** Weight of the bass swell in the full-frame brightness (a flare counts 1). */
const SWELL_WEIGHT = 0.5;

/**
 * Photosensitivity: the frame's audio-driven extra brightness — the ring's bass swell (its glow
 * and width) plus the brightest flare — goes through the flash limiter (lib/flash.js). `scale`
 * (0–1) is what to multiply both by this frame: 1 unless the limiter is holding back a rise.
 */
export function createGlare() {
  const flash = createFlashLimiter();
  const g = {
    /** Limited extra brightness. */
    level: 0,
    scale: 1,
    /**
     * @param {number} swell ring swell 0–1
     * @param {Float32Array} flares createFlares().data
     * @param {number} dt seconds
     * @param {boolean} enabled `ctx.reduceFlashing`
     */
    step(swell, flares, dt, enabled) {
      let top = 0;
      for (let i = 1; i < flares.length; i += 2) if (flares[i] > top) top = flares[i];
      const target = SWELL_WEIGHT * swell + top;
      g.level = flash.step(target, dt, enabled);
      g.scale = target > 1e-6 ? Math.min(1, g.level / target) : 1;
    },
  };
  return g;
}

/** Tint names, as in the manifest's `tint` options. */
export const TINTS = ["monochrome", "silver", "sepia", "cold blue"];

// Per-channel gamma applied to the grey value: like toning a silver print, it colours the greys
// while pure black and pure white stay put. Rows follow TINTS.
// prettier-ignore
const TINT_GAMMA = new Float32Array([
  1, 1, 1,
  1.06, 1.0, 0.9,     // silver: a faint cool metallic cast
  0.82, 1.0, 1.35,    // sepia: warm browns
  1.35, 1.1, 0.8,     // cold blue
]);

/**
 * The tint's per-channel gamma (color = grey^gamma). Unknown names → monochrome.
 * @param {unknown} name
 * @param {Float32Array} out length ≥ 3
 */
export function tintGamma(name, out) {
  const i = Math.max(0, TINTS.indexOf(String(name)));
  out[0] = TINT_GAMMA[3 * i];
  out[1] = TINT_GAMMA[3 * i + 1];
  out[2] = TINT_GAMMA[3 * i + 2];
  return out;
}

/**
 * Alpha of the sky: "black" (default) paints it opaque black; "none" leaves black transparent so
 * the ring and corona float on the desktop (premultiplied, alpha = brightest channel).
 * @param {unknown} name
 */
export function skyAlpha(name) {
  return name === "none" ? 0 : 1;
}

/** Margin around the composition's unit circle, as a fraction of min(width, height). */
const MARGIN = 0.03;

/**
 * Layout for any aspect: the composition's unit circle (the corona's full reach) is centred and
 * fits min(width, height) with a margin; clouds spill beyond it into the corners.
 * @param {number} width drawing-buffer px
 * @param {number} height
 * @param {{ cx: number, cy: number, radius: number }} out
 */
export function fitEclipse(width, height, out) {
  out.cx = width / 2;
  out.cy = height / 2;
  out.radius = Math.max(1, (Math.min(width, height) / 2) * (1 - 2 * MARGIN));
  return out;
}

/** Manifest defaults of Rotation (rad/s) and Reactivity; Reduce motion eases only these. */
export const DEFAULT_ROTATION = 0.03;
export const DEFAULT_REACTIVITY = 1;

/**
 * Motion after `ctx.reduceMotion`: calmer defaults (a third of the rotation, 70 % reactivity)
 * while the user's own picks are respected; the cloud drift is always slower.
 * @param {number} rotation Rotation param, rad/s
 * @param {number} reactivity Reactivity param
 * @param {boolean} reduceMotion
 * @param {{ rotation: number, reactivity: number, drift: number }} out
 */
export function effectiveMotion(rotation, reactivity, reduceMotion, out) {
  out.rotation = rotation;
  out.reactivity = reactivity;
  out.drift = 1;
  if (reduceMotion) {
    if (rotation === DEFAULT_ROTATION) out.rotation = rotation / 3;
    if (reactivity === DEFAULT_REACTIVITY) out.reactivity = 0.7 * reactivity;
    out.drift = 0.4;
  }
  return out;
}

/** Waveform points along each half of the ring (bottom → top), and their smoothing (s). */
const RIPPLE_POINTS = 32;
const RIPPLE_TAU = 0.06;

/**
 * The ring's edge ripple: the waveform (any length; read `.length`) averaged into RIPPLE_POINTS
 * blocks laid from the bottom of the ring to the top on both sides (mirrored like the corona),
 * eased in time and interpolated per sector, so the edges breathe with the wave without jaggies.
 * `out` is −1..1 per sector (the shader scales it to a hairline).
 * @param {number} [count]
 */
export function createRipple(count = SECTORS) {
  const out = new Float32Array(count);
  const pts = new Float32Array(RIPPLE_POINTS);
  return {
    out,
    /** @param {ArrayLike<number>} wave `audio.waveform` @param {number} dt */
    step(wave, dt) {
      const len = wave.length;
      const k = 1 - Math.exp(-dt / RIPPLE_TAU);
      for (let j = 0; j < RIPPLE_POINTS; j++) {
        const a = Math.floor((j * len) / RIPPLE_POINTS);
        const b = Math.floor(((j + 1) * len) / RIPPLE_POINTS);
        let sum = 0;
        for (let i = a; i < b; i++) sum += wave[i];
        const m = b > a ? sum / (b - a) : 0;
        const v = m > -1 ? (m < 1 ? m : 1) : m <= -1 ? -1 : 0; // NaN → 0
        pts[j] += (v - pts[j]) * k;
      }
      for (let i = 0; i < count; i++) {
        const h = Math.abs((i + 0.5) / count - 0.5) * 2; // 0 bottom … 1 top
        const x = h * (RIPPLE_POINTS - 1);
        const j = Math.min(RIPPLE_POINTS - 2, Math.floor(x));
        out[i] = pts[j] + (pts[j + 1] - pts[j]) * (x - j);
      }
    },
  };
}
