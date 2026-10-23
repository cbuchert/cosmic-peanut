// @ts-check
/**
 * Lattice's beat envelope: tempo-locked when the tempo is confident (a beat on each `beatPhase`
 * wrap), strong onsets otherwise — Tie-Dye's `createFlow` rule. Each beat eases the envelope up
 * with a smoothstep over RISE seconds, then back to 0 with another over the rest of FALL beats:
 * zero slope at every join, so nothing clicks. `step` allocates nothing.
 */

/** Without a confident tempo, onsets at least this strong count as beats. */
export const BEAT_STRENGTH = 0.6;
/** Seconds after an onset beat before another can count (fast fills don't machine-gun). */
export const REFRACTORY = 0.2;
/** Seconds the envelope takes to ease up to its peak. */
export const RISE = 0.08;
/** The envelope is back to 0 this many beats after the beat (rise included). */
export const FALL = 0.9;
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
  let since = Infinity; // since the last beat
  let t = Infinity; // since the envelope last started rising
  let from = 0;
  let level = 0;
  let fall = 1; // seconds of fall after the rise
  const b = {
    /** The beat envelope, 0–1. */
    env: 0,
    /** True on the frame of a beat. */
    beat: false,
    /** Beats so far. */
    count: 0,
    /** @param {BeatInput} a @param {number} dt seconds */
    step(a, dt) {
      t += dt;
      since += dt;
      const tempo = a.bpm > 0;
      const strength = Math.max(0, Math.min(1, a.onsetStrength));
      b.beat = tempo
        ? a.beatPhase < phase - 0.5
        : a.onset && strength >= BEAT_STRENGTH && since >= REFRACTORY;
      phase = tempo ? a.beatPhase : 0;
      if (b.beat) {
        b.count++;
        since = 0;
        from = b.env;
        level = tempo ? 1 : strength;
        t = 0;
        fall = Math.max(0.05, FALL * (a.bpm > 0 ? 60 / a.bpm : FALLBACK_PERIOD) - RISE);
      }
      if (t < RISE) b.env = from + (level - from) * smooth(t / RISE);
      else b.env = level * (1 - smooth((t - RISE) / fall));
      return b;
    },
  };
  return b;
}
