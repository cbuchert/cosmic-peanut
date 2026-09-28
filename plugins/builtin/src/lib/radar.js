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

/** Ground clutter lives inside this radius and never exceeds CLUTTER_MAX. */
export const CLUTTER_R = 0.22;
export const CLUTTER_MAX = 0.35;

/**
 * Ground-clutter amplitude by radius from the waveform: each radius near the center takes the mean
 * |sample| of its own slice of the waveform, fading to nothing at CLUTTER_R. The shader multiplies
 * it by per-texel noise to speckle it.
 * @param {ArrayLike<number>} waveform `audio.waveform` (any length; read `.length`)
 * @param {Float32Array} out
 */
export function clutterProfile(waveform, out) {
  const n = out.length;
  const len = waveform.length;
  const zone = Math.ceil(CLUTTER_R * n);
  for (let k = 0; k < n; k++) {
    const r = (k + 0.5) / n;
    if (r >= CLUTTER_R || len === 0) {
      out[k] = 0;
      continue;
    }
    const a = Math.floor((k * len) / zone);
    const b = Math.max(a + 1, Math.floor(((k + 1) * len) / zone));
    let sum = 0;
    for (let j = a; j < b; j++) sum += Math.abs(waveform[j]);
    out[k] = CLUTTER_MAX * Math.min(1, (3 * sum) / (b - a)) * (1 - r / CLUTTER_R);
  }
  return out;
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

/** Contacts live this many rotations, fading linearly. */
export const CONTACT_LIFE = 3;
/** Between passes a contact glows at FLARE_BASE; a pass flares it to full, fading over FLARE_TURNS. */
const FLARE_BASE = 0.3;
const FLARE_TURNS = 0.2;
/** A band whose level jumps by this much in one frame spawns a contact even without an onset. */
export const ATTACK_MIN = 0.3;

/**
 * Radar contacts ("blips") from transients, in a preallocated pool of `cap`. Each lives at the
 * bearing where the sweep was and the radius of the band that fired, flares when the sweep passes
 * over it and fades over CONTACT_LIFE rotations. Nothing allocates after creation.
 * @param {number} [cap=32]
 */
export function createContacts(cap = 32) {
  const c = {
    cap,
    bearing: new Float32Array(cap),
    radius: new Float32Array(cap),
    strength: new Float32Array(cap),
    /** Sweep angle (unwrapped turns) at spawn. */
    born: new Float64Array(cap),
    /** Sweep angle (unwrapped turns) when the arm last passed over it. */
    swept: new Float64Array(cap),
    /** Previous frame's band levels, for per-band attacks. */
    prevBands: new Float32Array(64),
    /** False until the first step has filled prevBands (starting mid-song is not an attack). */
    primed: false,
    /**
     * @param {number} prevTurns sweep angle last frame
     * @param {number} turns sweep angle now
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {ArrayLike<number>} bands `audio.bands`
     */
    step(prevTurns, turns, onset, onsetStrength, bands) {
      let best = -1;
      let bestAttack = -Infinity;
      for (let b = 0; b < 64; b++) {
        const a = bands[b] - c.prevBands[b];
        if (a > bestAttack) {
          bestAttack = a;
          best = b;
        }
        c.prevBands[b] = bands[b];
      }
      const start = prevTurns - Math.floor(prevTurns);
      const span = Math.min(1, Math.max(0, turns - prevTurns));
      for (let i = 0; i < cap; i++) {
        if (c.strength[i] <= 0) continue;
        if (turns - c.born[i] >= CONTACT_LIFE) c.strength[i] = 0;
        else if (inWedge(c.bearing[i], start, span)) c.swept[i] = turns;
      }
      if (!c.primed) {
        c.primed = true;
        return;
      }
      if (onset) c.spawn(turns, best, Math.min(1, 0.5 + onsetStrength));
      else if (bestAttack >= ATTACK_MIN) c.spawn(turns, best, Math.min(1, 0.3 + bestAttack));
    },
    /**
     * Put a contact at the sweep bearing and band `band`'s radius.
     * @param {number} turns @param {number} band @param {number} strength
     */
    spawn(turns, band, strength) {
      let slot = 0; // a free slot, else the oldest contact
      for (let i = 0; i < cap; i++) {
        if (c.strength[i] <= 0) {
          slot = i;
          break;
        }
        if (c.born[i] < c.born[slot]) slot = i;
      }
      c.bearing[slot] = turns - Math.floor(turns);
      c.radius[slot] = radiusOfBand(band);
      c.strength[slot] = strength;
      c.born[slot] = turns;
      c.swept[slot] = turns;
    },
    /** Current brightness of contact `i` (0 = dead). @param {number} i @param {number} turns */
    brightness(i, turns) {
      const life = 1 - (turns - c.born[i]) / CONTACT_LIFE;
      if (life <= 0) return 0;
      const flare = Math.exp(-(turns - c.swept[i]) / FLARE_TURNS);
      return c.strength[i] * life * (FLARE_BASE + (1 - FLARE_BASE) * flare);
    },
    /**
     * Pack live contacts as (bearing, radius, brightness, strength) quads for a vec4 uniform array.
     * @param {Float32Array} out length ≥ 4 × cap
     * @param {number} turns sweep angle now
     * @returns {number} how many were written
     */
    pack(out, turns) {
      let n = 0;
      for (let i = 0; i < cap; i++) {
        const b = c.brightness(i, turns);
        if (b <= 0) continue;
        out[4 * n] = c.bearing[i];
        out[4 * n + 1] = c.radius[i];
        out[4 * n + 2] = b;
        out[4 * n + 3] = c.strength[i];
        n++;
      }
      return n;
    },
  };
  return c;
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
 * returns, contacts). Unknown names fall back to green.
 * @param {unknown} name
 * @param {Float32Array} out length ≥ 6
 */
export function phosphorPalette(name, out) {
  const i = Math.max(0, PALETTES.indexOf(String(name)));
  for (let k = 0; k < 6; k++) out[k] = PALETTE_RGB[6 * i + k];
  return out;
}
