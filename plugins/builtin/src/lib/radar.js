// @ts-check
/** Radar's pure logic: sweep, swept wedge, log-frequency spectrum column, dB level, decay, layout. */

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

/**
 * Where `bearing` sits in the swept wedge, 0 at its start (painted with last frame's spectrum,
 * which the previous wedge ended on) to 1 at the arm (this frame's), so a fast sweep blends
 * between the two instead of showing steps. A full-turn (or empty) wedge takes this frame's.
 * Mirrored in shaders/radar/paint.frag.
 * @param {number} bearing @param {number} start @param {number} span
 */
export function wedgeMix(bearing, start, span) {
  if (span >= 1 || span <= 0) return 1;
  const d = bearing - start;
  return Math.min(1, (d - Math.floor(d)) / span);
}

/** Radius (fraction of the scope) of the lowest (F_MIN) and highest (`maxFreq`) frequency drawn. */
export const R_INNER = 0.06;
export const R_OUTER = 0.95;
/** Lowest frequency drawn (Hz), at R_INNER; the top one (the `maxFreq` param) sits at R_OUTER. */
export const F_MIN = 40;

/**
 * Radius (0–1 of the scope) of frequency `hz` on a log scale: F_MIN at R_INNER, `maxHz` at
 * R_OUTER, every octave the same width.
 * @param {number} hz
 * @param {number} maxHz
 */
export function radiusOfFreq(hz, maxHz) {
  return R_INNER + ((R_OUTER - R_INNER) * Math.log(hz / F_MIN)) / Math.log(maxHz / F_MIN);
}

/** Inverse of radiusOfFreq. @param {number} r @param {number} maxHz */
export function freqAtRadius(r, maxHz) {
  return F_MIN * Math.pow(maxHz / F_MIN, (r - R_INNER) / (R_OUTER - R_INNER));
}

/** Magnitude at fractional bin position `x` (linear between bins; 0 outside the spectrum). */
function lerpBin(/** @type {ArrayLike<number>} */ s, /** @type {number} */ x) {
  const len = s.length;
  if (x < 0 || x > len - 1) return 0;
  const i = Math.min(len - 2, Math.floor(x));
  const f = x - i;
  return s[i] + (s[i + 1] - s[i]) * f;
}

/**
 * Resample a linear magnitude spectrum onto the phosphor's radial texels on the log-frequency scale
 * (radiusOfFreq). Texel k covers radii [k/n, (k+1)/n], i.e. a band of fractional bins [b0, b1]:
 * it takes the max of the bins inside it and of the spectrum interpolated at both edges, so a
 * narrow partial keeps its full strength however many bins a texel spans, and texels narrower than
 * a bin interpolate smoothly. Radii below F_MIN or above `maxHz` are black. Allocation-free.
 * @param {ArrayLike<number>} spectrum `audio.spectrum` (any length; bin i ≈ i · (sampleRate/2) / length Hz)
 * @param {number} sampleRate
 * @param {number} maxHz frequency at R_OUTER
 * @param {Float32Array} out one value per radial texel
 */
export function spectrumColumn(spectrum, sampleRate, maxHz, out) {
  const n = out.length;
  const len = spectrum.length;
  const binsPerHz = (2 * len) / sampleRate;
  for (let k = 0; k < n; k++) {
    const r0 = Math.max(R_INNER, k / n);
    const r1 = Math.min(R_OUTER, (k + 1) / n);
    if (r1 <= r0 || len < 2) {
      out[k] = 0;
      continue;
    }
    const b0 = freqAtRadius(r0, maxHz) * binsPerHz;
    const b1 = freqAtRadius(r1, maxHz) * binsPerHz;
    let v = Math.max(lerpBin(spectrum, b0), lerpBin(spectrum, b1));
    const hi = Math.min(len - 1, Math.floor(b1));
    for (let i = Math.max(0, Math.ceil(b0)); i <= hi; i++) if (spectrum[i] > v) v = spectrum[i];
    out[k] = v;
  }
  return out;
}

/** Auto-gain: the reference level never drops below REF_MIN dB (at most this much boost). */
export const REF_MIN = -40;
/** Auto-gain time constants (s): rising to a louder passage, and relaxing after it. */
const AGC_ATTACK = 1;
const AGC_RELEASE = 6;

/**
 * Magnitude → phosphor brightness in dB: `floorDb` (negative) below the reference level is black,
 * the reference is full brightness, linear in dB between. The reference is a slow auto-gain on the
 * column's peak (between REF_MIN and 0 dB), so quiet tracks still show and loud ones don't
 * saturate. Deterministic and allocation-free.
 */
export function createLevel() {
  const l = {
    /** Reference level, dB: follows the loudest texel, slowly (AGC_ATTACK / AGC_RELEASE). */
    ref: 0,
    /**
     * @param {Float32Array} column linear magnitudes (spectrumColumn)
     * @param {number} dt seconds
     * @param {number} floorDb e.g. −60
     * @param {number} gain brightness multiplier
     * @param {Float32Array} out brightness per texel
     */
    step(column, dt, floorDb, gain, out) {
      const range = Math.max(1, -floorDb);
      let peak = 0;
      for (let k = 0; k < column.length; k++) if (column[k] > peak) peak = column[k];
      const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      // Hold through silence (nothing above the floor), so a pause doesn't blow the gain up.
      if (peakDb > l.ref - range) {
        const target = Math.min(0, Math.max(REF_MIN, peakDb));
        const tau = target > l.ref ? AGC_ATTACK : AGC_RELEASE;
        l.ref += (target - l.ref) * (1 - Math.exp(-dt / tau));
      }
      const lo = l.ref - range;
      for (let k = 0; k < column.length; k++) {
        const m = column[k];
        const db = m > 0 ? 20 * Math.log10(m) : -Infinity;
        out[k] = Math.min(1, Math.max(0, (db - lo) / range)) * gain;
      }
      return out;
    },
  };
  return l;
}

/** Phosphor decay runs in fixed steps of this many seconds, whatever the display rate. */
export const DECAY_STEP = 1 / 240;
/** Floor on the rate used for decay (turns/s), so a stopped sweep still fades. */
const DECAY_MIN_RATE = 0.05;

/**
 * Fixed-timestep phosphor decay. `persistence` is the afterglow's time constant in rotations, so
 * the trail always fades over about the same arc whatever the sweep speed.
 */
export function createDecay() {
  const d = {
    /** Unconsumed time, seconds. */
    acc: 0,
    /**
     * @param {number} dt seconds
     * @param {number} rate sweep rate, turns/s
     * @param {number} persistence afterglow, rotations
     * @returns {number} factor to multiply the phosphor by this frame
     */
    step(dt, rate, persistence) {
      d.acc += dt;
      const n = Math.floor(d.acc / DECAY_STEP + 1e-9);
      d.acc = Math.max(0, d.acc - n * DECAY_STEP);
      const perStep = (DECAY_STEP * Math.max(DECAY_MIN_RATE, rate)) / Math.max(0.01, persistence);
      return Math.exp(-n * perStep);
    },
  };
  return d;
}

/** Gap between the scope's bezel and the nearer canvas edge, as a fraction of min(width, height). */
export const MARGIN = 0.06;

/**
 * Center and radius (drawing-buffer pixels) of the largest scope that fits the canvas with MARGIN
 * to spare. The bezel is drawn just outside `radius`.
 * @param {number} width
 * @param {number} height
 * @param {{ cx: number, cy: number, radius: number }} out
 */
export function fitScope(width, height, out) {
  out.cx = width / 2;
  out.cy = height / 2;
  out.radius = (Math.min(width, height) / 2) * (1 - 2 * MARGIN);
  return out;
}

/** Palette names, as in the manifest's `palette` options. */
export const PALETTES = ["green", "amber", "blue", "white"];

// Glow, then hot core, per palette: P7-like green, P3 amber, blue, and a paper-white.
// prettier-ignore
const PALETTE_RGB = new Float32Array([
  0.22, 1.0, 0.35,   0.75, 1.0, 0.8,
  1.0, 0.6, 0.12,    1.0, 0.88, 0.6,
  0.25, 0.6, 1.0,    0.75, 0.9, 1.0,
  0.9, 0.93, 0.96,   1.0, 1.0, 1.0,
]);

/**
 * Phosphor colors for a palette: `out[0..2]` the glow, `out[3..5]` the hot core (sweep arm, fresh
 * returns). Unknown names fall back to green.
 * @param {unknown} name
 * @param {Float32Array} out length ≥ 6
 */
export function phosphorPalette(name, out) {
  const i = Math.max(0, PALETTES.indexOf(String(name)));
  for (let k = 0; k < 6; k++) out[k] = PALETTE_RGB[6 * i + k];
  return out;
}
