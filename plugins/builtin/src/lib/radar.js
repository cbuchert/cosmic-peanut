// @ts-check
/** Radar's pure logic: sweep, swept wedge, band→radius profile, contacts, clutter, layout. */

/**
 * @typedef {object} SweepInput
 * @property {string} sync "off" | "beat" | "bar"
 * @property {number} speed rotations per second when not tempo-locked
 * @property {number} bpm `audio.bpm` (0 = unknown)
 * @property {number} beatPhase `audio.beatPhase`, 0–1
 * @property {boolean} reduceMotion `ctx.reduceMotion`
 */

/** Manifest default of the Speed param (rotations/s), and what Reduce motion uses instead. */
export const DEFAULT_SPEED = 0.25;
export const REDUCED_SPEED = 0.1;

/** Beats per rotation for each tempo-locked `sync` value. */
const BEATS_PER_TURN = { beat: 1, bar: 4 };
/** Phase-alignment gain (1/s) and the most it may bend the tempo rate (fraction of it). */
const ALIGN_GAIN = 1.5;
const ALIGN_MAX = 0.5;
/** Time constant (s) with which the rotation rate follows its target, so the arm never jerks. */
const RATE_TAU = 0.25;

/**
 * Sweep arm angle in turns (0 = north, clockwise), unwrapped and never decreasing.
 *
 * Free-running it turns at `speed`. Tempo-locked (`sync` beat/bar with a known bpm) it turns once
 * per beat or per bar and steers its phase so beats land on 0° (beat) or on the quarter bearings
 * (bar): the rate is bent by at most ±ALIGN_MAX, and the rate itself is smoothed, so the angle
 * never jumps.
 */
export function createSweep() {
  const s = {
    /** Unwrapped angle, turns. */
    turns: 0,
    /** Current rate, turns/s (NaN until the first step). */
    rate: NaN,
    /**
     * @param {number} dt seconds
     * @param {SweepInput} o
     * @returns {number} the new angle, turns
     */
    step(dt, o) {
      let bpt = o.sync === "beat" || o.sync === "bar" ? BEATS_PER_TURN[o.sync] : 0;
      let speed = o.speed;
      if (o.reduceMotion) {
        // Gentler defaults; anything the user picked is respected.
        if (speed === DEFAULT_SPEED) speed = REDUCED_SPEED;
        if (o.sync === "bar") bpt *= 2;
      }
      let target = Math.max(0, speed);
      if (bpt && o.bpm > 0) {
        const base = o.bpm / 60 / bpt;
        const beats = (s.turns + base * dt) * bpt; // where the arm lands this frame
        let err = o.beatPhase - (beats - Math.floor(beats)); // beats
        err -= Math.round(err); // −0.5..0.5
        const corr = (ALIGN_GAIN * err) / bpt;
        target = base + Math.max(-ALIGN_MAX * base, Math.min(ALIGN_MAX * base, corr));
      }
      s.rate = Number.isNaN(s.rate) ? target : s.rate + (target - s.rate) * (1 - Math.exp(-dt / RATE_TAU));
      s.turns += s.rate * dt;
      return s.turns;
    },
  };
  return s;
}

/**
 * The wedge the arm swept since the previous frame, as `out = [start, span]` in turns
 * (start 0–1, span 0–1). Painting the half-open wedge [start, start + span) every frame covers
 * each bearing exactly once per rotation, however fast the arm turns.
 * @param {number} prevTurns unwrapped angle last frame
 * @param {number} turns unwrapped angle now
 * @param {Float32Array | number[]} out length ≥ 2
 */
export function sweptWedge(prevTurns, turns, out) {
  out[0] = prevTurns - Math.floor(prevTurns);
  out[1] = Math.min(1, Math.max(0, turns - prevTurns));
  return out;
}

/**
 * Whether `bearing` (turns) lies in the half-open wedge [start, start + span), wrapping at 1.
 * Mirrored in shaders/radar/paint.frag.
 * @param {number} bearing
 * @param {number} start
 * @param {number} span
 */
export function inWedge(bearing, start, span) {
  const d = bearing - start;
  return span >= 1 || d - Math.floor(d) < span;
}

/** Radius (fraction of the scope) of band 0 and band 63; beyond these the spectrum fades out. */
export const R_INNER = 0.06;
export const R_OUTER = 0.95;
/** Band levels below this are silence (the analyzer's noise floor), so a quiet scope is dark. */
export const GATE = 0.06;

/** Radius (0–1 of the scope) where band `i` (0–63, may be fractional) is drawn. @param {number} i */
export function radiusOfBand(i) {
  return R_INNER + ((R_OUTER - R_INNER) * i) / 63;
}

/**
 * The radial profile the sweep paints this frame: `out[k]` is the return at radius (k + 0.5) / n,
 * interpolated between the two nearest bands (bass at the center, highs at the rim), gated and
 * scaled by `gain`.
 * @param {ArrayLike<number>} bands `audio.bands` (64)
 * @param {number} gain
 * @param {Float32Array} out
 */
export function bandProfile(bands, gain, out) {
  const n = out.length;
  const edge = R_OUTER + (R_OUTER - R_INNER) / 126; // half a band past the last one
  for (let k = 0; k < n; k++) {
    const r = (k + 0.5) / n;
    if (r > edge) {
      out[k] = 0;
      continue;
    }
    const x = Math.min(63, Math.max(0, ((r - R_INNER) / (R_OUTER - R_INNER)) * 63));
    const i = Math.min(62, Math.floor(x));
    const f = x - i;
    const v = bands[i] * (1 - f) + bands[i + 1] * f;
    out[k] = (Math.max(0, v - GATE) / (1 - GATE)) * gain;
  }
  return out;
}
