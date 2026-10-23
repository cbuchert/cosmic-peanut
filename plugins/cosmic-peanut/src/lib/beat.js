// @ts-check
/**
 * Beat envelope for Möbius's wring, breath and glow. Locked to the tempo when it's confident (a
 * beat on each `beatPhase` wrap; onsets only accent), from strong onsets otherwise, like Tie-Dye's
 * `createFlow` in the builtin pack (packs are served separately, so the idea is copied, not
 * imported). Each beat eases the envelope up to its level with a smoothstep over RISE seconds,
 * then eases it back to 0 with another over the rest of FALL beats: zero slope at every join, so
 * nothing clicks. A beat that lands mid-envelope rises from wherever it is. `step` allocates
 * nothing.
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
/** Seconds the envelope takes to ease up to its peak. */
export const RISE = 0.08;
/** The envelope is back to 0 this many beats after the beat (rise included). */
const FALL = 0.9;
/** Beat length (s) assumed without a tempo (120 BPM). */
const FALLBACK_PERIOD = 0.5;

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * @typedef {object} BeatInput
 * @property {number} bpm `audio.bpm` (0 until confident)
 * @property {number} beatPhase `audio.beatPhase`
 * @property {boolean} onset `audio.onset`
 * @property {number} onsetStrength `audio.onsetStrength`
 */

export function createBeat() {
  let phase = 0;
  let since = Infinity; // since the last beat (refractory gap)
  let t = Infinity; // since the envelope last started rising
  let fall = 1; // seconds of fall after the rise
  let from = 0; // envelope and swing when the rise started, and where they're heading
  let fromSwing = 0;
  let level = 0;
  let side = 1;
  const b = {
    /** The beat envelope, 0–1 (peaks at the beat's level RISE seconds after it). */
    env: 0,
    /** The envelope with a sign that alternates each beat (+ on odd beats), eased through the flip. */
    swing: 0,
    /** Beats so far. */
    count: 0,
    /** True on the frame of a beat. */
    beat: false,
    /** @param {BeatInput} a @param {number} dt seconds */
    step(a, dt) {
      const tempo = a.bpm > 0;
      since += dt;
      t += dt;
      const strength = Math.max(0, Math.min(1, a.onsetStrength));
      if (tempo) {
        b.beat = a.beatPhase < phase - 0.5;
        phase = a.beatPhase;
      } else {
        b.beat = a.onset && strength >= BEAT_STRENGTH && since >= REFRACTORY;
        phase = 0;
      }
      let next = -1;
      if (b.beat) {
        b.count++;
        since = 0;
        side = b.count % 2 === 1 ? 1 : -1;
        next = tempo ? 1 : strength;
      } else if (tempo && a.onset && ONSET_ACCENT * strength > b.env) {
        next = ONSET_ACCENT * strength; // an accent: same side, no count
      }
      if (next >= 0) {
        from = b.env;
        fromSwing = b.swing;
        level = next;
        t = 0;
        fall = Math.max(0.05, FALL * (tempo ? 60 / a.bpm : FALLBACK_PERIOD) - RISE);
      }
      if (t < RISE) {
        const k = smooth(t / RISE);
        b.env = from + (level - from) * k;
        b.swing = fromSwing + (side * level - fromSwing) * k;
      } else {
        const k = 1 - smooth((t - RISE) / fall);
        b.env = level * k;
        b.swing = side * level * k;
      }
      return b;
    },
  };
  return b;
}

/** Most twist offset (rad) at full swing and Beat 1: the strip rolls about its centre line. */
export const WRING = 0.2;
/** Width swell per unit of envelope × Beat. */
export const BREATH = 0.07;
/** Brightness lift of the newest slices per unit of envelope × Beat (rings.frag `uGlow`). */
export const GLOW = 0.25;
/** Extra amplitude of rings pushed at the envelope's peak, per unit of Beat. */
export const STAMP = 0.8;
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

/**
 * Gain for the rings pushed now (`history.step`'s `gain`): the beat is baked into the history,
 * so each beat travels along the strip as a band of louder slices.
 * @param {number} env createBeat's `env` @param {number} beat the Beat param (after `gentle`)
 */
export function stamp(env, beat) {
  return 1 + STAMP * env * beat;
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
