// @ts-check
/**
 * Dark Sun's upside-down horizon: the live spectrum as an inverted mountain range hanging from the
 * horizon. Pure and allocation-free per step; the shader draws straight segments between texels.
 *
 * The profile has `n` texels across the range. It is mirrored like the cover: the lowest
 * frequency at the two centre texels, the highest toward both edges, on a log axis (spectro.js
 * logColumns "mirrored"). Each texel's level comes from spectro.js (max-over-bins resampling,
 * dB floor, slow per-frequency auto-gain), is shaped by Reactivity, and tapers to zero at the
 * range's sides so it meets the flat horizon.
 */
import { createSpectroGain, logColumns, resampleSpectrum } from "./spectro.js";

/** Frequency span of each half of the range (Hz): lowest at the centre, highest at the edges. */
export const F_MIN = 40;
export const F_MAX = 14000;
/** Fraction of each half (from its outer edge) over which the range tapers to the horizon. */
export const TAPER = 0.3;
/** Depth of the static, jagged ridge the range rests at in silence (so the motif stays). */
export const REST = 0.1;

/**
 * Reactivity as a level curve: 0 flattens the range, 1 is linear, 2 lifts quiet peaks
 * (level^(1/r)). Always 0–1.
 * @param {number} level 0–1
 * @param {number} reactivity 0–2
 */
export function shapeLevel(level, reactivity) {
  const l = level > 0 ? (level < 1 ? level : 1) : 0;
  const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
  return r <= 1 ? l * r : l ** (1 / r);
}

/**
 * Edge taper per texel: 0 at the outermost texels, smoothstep up to 1 by TAPER of the half-width.
 * @param {Float32Array} out
 */
export function edgeTaper(out) {
  const n = out.length;
  const half = n / 2 - 0.5;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i, n - 1 - i) / half / TAPER; // 0 at the edge, 1 where the taper ends
    const t = d < 1 ? d : 1;
    out[i] = t * t * (3 - 2 * t);
  }
}

/** Seconds a peak holds before it starts to fall. */
export const HOLD = 0.3;
/** Envelope time constants (s): peaks jump in, then sink back slowly. */
const ATTACK = 0.02;
const RELEASE = 0.55;

/**
 * Per-texel envelope with peak-hold, frame-rate independent. The follower rises with a fast
 * attack and falls with a slow release; the held peak keeps the follower's top for HOLD seconds,
 * then eases down onto it with the same release. Output = held peak, 0–1 (bad input reads as 0).
 * @param {number} n texels
 */
export function createPeakEnvelope(n) {
  const env = new Float32Array(n);
  const peak = new Float32Array(n);
  const age = new Float32Array(n);
  return {
    /**
     * @param {ArrayLike<number>} input levels, 0–1
     * @param {number} dt seconds
     * @param {Float32Array} out held level per texel
     */
    step(input, dt, out) {
      const ka = 1 - Math.exp(-dt / ATTACK);
      const kr = 1 - Math.exp(-dt / RELEASE);
      for (let i = 0; i < n; i++) {
        const v = input[i];
        const x = v > 0 ? (v < 1 ? v : 1) : 0; // NaN → 0
        const e = env[i] + (x - env[i]) * (x > env[i] ? ka : kr);
        env[i] = e;
        let p = peak[i];
        if (e >= p) {
          p = e;
          age[i] = 0;
        } else {
          age[i] += dt;
          if (age[i] > HOLD) p += (e - p) * kr;
        }
        peak[i] = p;
        out[i] = p;
      }
    },
  };
}

/**
 * The silent range: a fixed, symmetric, jagged ridge up to REST deep, deeper toward the centre.
 * Deterministic (a hash of the distance from the centre), never random per frame.
 * @param {Float32Array} out
 */
export function restRidge(out) {
  const n = out.length;
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    const k = i < half ? half - 1 - i : i - half; // 0 at the centre texels
    const h = Math.sin((k + 1) * 12.9898) * 43758.5453;
    const jag = h - Math.floor(h);
    out[i] = REST * (0.35 + 0.65 * jag) * (1 - 0.5 * (k / half));
  }
}

/** @param {number} n texels across the whole range (even) */
export function createHorizon(n) {
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  const mags = new Float32Array(n);
  const levels = new Float32Array(n);
  const taper = new Float32Array(n);
  const rest = new Float32Array(n);
  const held = new Float32Array(n);
  const envelope = createPeakEnvelope(n);
  logColumns("mirrored", F_MIN, F_MAX, lo, hi);
  edgeTaper(taper);
  restRidge(rest);
  const gain = createSpectroGain(n);
  gain.setTilt(lo, hi);
  return {
    /**
     * @param {ArrayLike<number>} spectrum `audio.spectrum`
     * @param {number} sampleRate Hz
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {Float32Array} out depth per texel, 0–1
     */
    step(spectrum, sampleRate, dt, reactivity, out) {
      resampleSpectrum(spectrum, sampleRate, lo, hi, mags);
      gain.step(mags, dt, levels);
      for (let i = 0; i < n; i++) levels[i] = shapeLevel(levels[i], reactivity);
      envelope.step(levels, dt, held);
      for (let i = 0; i < n; i++) {
        const v = held[i];
        out[i] = taper[i] * (v > rest[i] ? v : rest[i]);
      }
    },
  };
}
