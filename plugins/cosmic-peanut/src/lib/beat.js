// @ts-check
/**
 * Beat envelope for Möbius's wring, breath and glow. Locked to the tempo when it's confident (a
 * beat on each `beatPhase` wrap; onsets only accent), from strong onsets otherwise, like Tie-Dye's
 * `createFlow` in the builtin pack (packs are served separately, so the idea is copied, not
 * imported). Each beat sets a kick to 1 that decays over about a beat; the envelope follows it
 * through a fast one-pole attack. `step` allocates nothing.
 *
 * The Beat param (0–2, default 1) scales all three effects; at 0, which is also what the sphere
 * gets (it has no Beat param), they do nothing.
 */

import { createFlashLimiter } from "./flash.js";

/** Without a confident tempo, onsets at least this strong count as beats. */
export const BEAT_STRENGTH = 0.6;
/** Seconds after an onset beat before another can count (fast fills don't machine-gun). */
export const REFRACTORY = 0.2;
/** With a confident tempo, an onset's kick is scaled by this: the beat leads, onsets only accent. */
export const ONSET_ACCENT = 0.2;
/** Attack time constant (s): quick, but the strip still rolls rather than snaps. */
const ATTACK = 0.015;
/** The kick falls by e^−DECAY over one beat (≈ 8% left when the next one lands). */
const DECAY = 2.5;
/** Beat length (s) assumed without a tempo (120 BPM). */
const FALLBACK_PERIOD = 0.5;

/**
 * @typedef {object} BeatInput
 * @property {number} bpm `audio.bpm` (0 until confident)
 * @property {number} beatPhase `audio.beatPhase`
 * @property {boolean} onset `audio.onset`
 * @property {number} onsetStrength `audio.onsetStrength`
 */

export function createBeat() {
  let kick = 0;
  let signed = 0;
  let phase = 0;
  let since = Infinity;
  const b = {
    /** The beat envelope, 0–1 (peaks ≈ 0.8 a few tens of ms after the beat). */
    env: 0,
    /** The envelope with a sign that alternates each beat (+ on odd beats), smoothed through the flip. */
    swing: 0,
    /** Beats so far. */
    count: 0,
    /** True on the frame of a beat. */
    beat: false,
    /** @param {BeatInput} a @param {number} dt seconds */
    step(a, dt) {
      const tempo = a.bpm > 0;
      const period = tempo ? 60 / a.bpm : FALLBACK_PERIOD;
      const fall = Math.exp((-dt * DECAY) / period);
      kick *= fall;
      signed *= fall;
      since += dt;
      const strength = Math.max(0, Math.min(1, a.onsetStrength));
      if (tempo) {
        b.beat = a.beatPhase < phase - 0.5;
        phase = a.beatPhase;
      } else {
        b.beat = a.onset && strength >= BEAT_STRENGTH && since >= REFRACTORY;
        phase = 0;
      }
      if (b.beat) {
        b.count++;
        since = 0;
        kick = tempo ? 1 : strength;
        signed = b.count % 2 === 1 ? kick : -kick;
      } else if (tempo && a.onset) {
        const accent = ONSET_ACCENT * strength;
        if (accent > kick) {
          signed = signed < 0 ? -accent : accent;
          kick = accent;
        }
      }
      const k = 1 - Math.exp(-dt / ATTACK);
      b.env += (kick - b.env) * k;
      b.swing += (signed - b.swing) * k;
      return b;
    },
  };
  return b;
}

/** Most twist offset (rad) at full swing and Beat 1: the strip rolls about its centre line. */
export const WRING = 0.45;
/** Width swell per unit of envelope × Beat. */
export const BREATH = 0.15;
/** Brightness lift of the newest slices per unit of envelope × Beat (rings.frag `uGlow`). */
export const GLOW = 0.6;
/** Under Reduce flashing the glow is scaled by this (and limited to 3 rises per second). */
const REDUCED_GLOW = 0.25;

/**
 * Twist offset φ (rad) added to the half twist u/2. Mirrors shaders/mobius.vert. A constant φ
 * keeps the strip a Möbius strip: the slices at u and u + 2π still differ by π.
 * @param {number} swing createBeat's `swing` @param {number} beat the Beat param (after `gentle`)
 */
export function wring(swing, beat) {
  return WRING * swing * beat;
}

/**
 * Strip half-width multiplier. Mirrors shaders/mobius.vert.
 * @param {number} env createBeat's `env` @param {number} beat the Beat param (after `gentle`)
 */
export function breath(env, beat) {
  return 1 + BREATH * env * beat;
}

/** The newest slices' beat glow (rings.frag `uGlow`), flash-limited under Reduce flashing. */
export function createGlow() {
  const limiter = createFlashLimiter();
  return {
    /**
     * @param {number} env createBeat's `env` @param {number} beat the Beat param
     * @param {number} dt seconds @param {boolean} reduceFlashing `ctx.reduceFlashing`
     */
    step(env, beat, dt, reduceFlashing) {
      const target = GLOW * env * beat * (reduceFlashing ? REDUCED_GLOW : 1);
      return limiter.step(target, dt, reduceFlashing);
    },
  };
}
