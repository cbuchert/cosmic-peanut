// @ts-check
/** Tie-Dye's pure logic: band widths, spin, blooms, arm warp, selection, band geometry, intensity. */
import { createFlashLimiter } from "./flash.js";

/** Most colors a palette may have (uniform array sizes in the shader). */
export const MAX_COLORS = 8;
/** Seconds for the band widths to follow the mix. */
const WIDTH_TAU = 0.35;
/** Extra width per unit of region energy (a silent region keeps width 1). */
const WIDTH_GAIN = 3;

export function createBandWidths() {
  const w = new Float32Array(MAX_COLORS);
  const energy = new Float32Array(MAX_COLORS);
  return {
    /**
     * @param {Float32Array} bands
     * @param {number} n
     * @param {number} dt
     * @param {number} reactivity
     */
    step(bands, n, dt, reactivity) {
      w.fill(0);
      const a = 1 - Math.exp(-dt / WIDTH_TAU);
      let total = 0;
      for (let k = 0; k < n; k++) {
        const lo = Math.floor((k * bands.length) / n);
        const hi = Math.floor(((k + 1) * bands.length) / n);
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        energy[k] += (e / Math.max(1, hi - lo) - energy[k]) * a;
        w[k] = 1 + WIDTH_GAIN * reactivity * energy[k];
        total += w[k];
      }
      for (let k = 0; k < n; k++) w[k] /= total;
      return w;
    },
  };
}

/**
 * @typedef {object} SpinInput
 * @property {number} twist the Twist param (turns of spiral across the radius)
 * @property {number} speed the Speed param (motion multiplier)
 * @property {number} motion the Motion param
 * @property {number} bassAtt `audio.bassAtt`
 * @property {number} energy createFlow's `energy`, 0–1
 * @property {number} bpm `audio.bpm` (0 until confident)
 * @property {number} reactivity the Reactivity param
 * @property {boolean} reduceMotion `ctx.reduceMotion`
 */

/** Manifest default of the Speed param. */
export const DEFAULT_SPEED = 1;
/** What Reduce motion uses instead of the default Speed, and how much slower the twist then follows. */
export const REDUCED_SPEED = 0.4;
const REDUCED_TWIST_SLOWDOWN = 3;
/** Rotation (turns/s at Speed 1): a slow drift plus a bass-driven part. */
const BASE_RATE = 0.02;
const BASS_RATE = 0.025;
/** More rotation with the music's energy (turns/s at full energy, Reactivity 2, 120 BPM). */
const ENERGY_RATE = 0.12;
/** A confident tempo scales the energy's part of the rotation by bpm / 120, within these. */
const TEMPO_MIN = 0.6;
const TEMPO_MAX = 1.6;
/** Most the bass can tighten (or loosen) the twist, as a fraction of the Twist param. */
export const TWIST_DEPTH = 0.35;
/** Smoothing time constants (s): the twist runs through two such stages, the rate one. */
const TWIST_TAU = 0.4;
const RATE_TAU = 0.5;

/**
 * Spiral twist and rotation from the bass. Heavier bass (bassAtt > 1) tightens the twist and
 * speeds the rotation. The twist follows its target through two one-pole stages (so its rate of
 * change is continuous too) and the rate through one, so neither jerks.
 */
export function createSpin() {
  let rate = NaN;
  let twistMid = NaN;
  const s = {
    /** Current twist, turns across the unit radius. */
    twist: NaN,
    /** Unwrapped rotation, turns. */
    turns: 0,
    /** @param {number} dt @param {SpinInput} o */
    step(dt, o) {
      // Reduce motion: gentler defaults; a Speed the user picked is respected.
      const gentle = o.reduceMotion && o.speed === DEFAULT_SPEED && o.motion === DEFAULT_MOTION;
      const scale = motionScale(o);
      const bass = Math.max(-1, Math.min(1, o.bassAtt - 1));
      const react = Math.max(0, Math.min(2, o.reactivity)) / 2;
      const twist = o.twist * (1 + TWIST_DEPTH * react * bass);
      const tempo = o.bpm > 0 ? Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, o.bpm / 120)) : 1;
      const energy = Math.max(0, Math.min(1, o.energy));
      const target = scale * (BASE_RATE + react * (BASS_RATE * (1 + bass) + ENERGY_RATE * tempo * energy));
      if (Number.isNaN(s.twist)) {
        s.twist = twistMid = twist;
        rate = target;
      }
      const kt = 1 - Math.exp(-dt / (gentle ? TWIST_TAU * REDUCED_TWIST_SLOWDOWN : TWIST_TAU));
      twistMid += (twist - twistMid) * kt;
      s.twist += (twistMid - s.twist) * kt;
      rate += (target - rate) * (1 - Math.exp(-dt / RATE_TAU));
      s.turns += rate * dt;
      return s;
    },
  };
  return s;
}

/** Dye blooms in the pool (uniform array size in the shader). */
export const BLOOM_CAP = 8;
/** Seconds a bloom lives: it bleeds outward, then fades into the pattern. */
export const BLOOM_LIFE = 1.8;
/** Blooms land within this radius (unit = half the shorter screen side). */
export const BLOOM_SPREAD = 0.75;
const BLOOM_GROW_TAU = 0.45;
const BLOOM_FADE_IN = 0.08;
const BLOOM_FADE_FROM = 0.7;

/** mulberry32: a tiny seeded PRNG, 0 ≤ x < 1. @param {number} seed */
export function prng(seed) {
  let t0 = seed | 0;
  return () => {
    t0 = (t0 + 0x6d2b79f5) | 0;
    let t = Math.imul(t0 ^ (t0 >>> 15), 1 | t0);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fixed pool of dye blooms. Each onset drops one at a seeded pseudo-random spot (recycling the
 * oldest when the pool is full); it bleeds outward quickly, then slows, and fades out over
 * BLOOM_LIFE seconds. `data` holds x, y, radius, amount per bloom and `color` a 0–1 palette
 * position, ready for uniform4fv / uniform1fv. Nothing is allocated per step.
 * @param {number} seed
 */
export function createBlooms(seed) {
  const rand = prng(seed);
  const age = new Float32Array(BLOOM_CAP).fill(Infinity);
  const size = new Float32Array(BLOOM_CAP);
  const strength = new Float32Array(BLOOM_CAP);
  let next = 0;
  const b = {
    /** Per bloom: x, y (unit-radius coordinates), radius, amount 0–1. */
    data: new Float32Array(BLOOM_CAP * 4),
    /** Per bloom: palette position 0–1. */
    color: new Float32Array(BLOOM_CAP),
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} dt seconds
     */
    step(onset, onsetStrength, dt) {
      for (let i = 0; i < BLOOM_CAP; i++) age[i] += dt;
      if (onset) {
        const i = next;
        next = (next + 1) % BLOOM_CAP;
        const r = BLOOM_SPREAD * Math.sqrt(rand());
        const a = 2 * Math.PI * rand();
        b.data[i * 4] = r * Math.cos(a);
        b.data[i * 4 + 1] = r * Math.sin(a);
        b.color[i] = rand();
        const st = Math.min(1, 0.5 + Math.max(0, onsetStrength));
        strength[i] = st;
        size[i] = (0.1 + 0.12 * rand()) * (0.6 + 0.4 * st);
        age[i] = 0;
      }
      for (let i = 0; i < BLOOM_CAP; i++) {
        const t = age[i];
        if (!(t < BLOOM_LIFE)) {
          b.data[i * 4 + 2] = 0;
          b.data[i * 4 + 3] = 0;
          continue;
        }
        b.data[i * 4 + 2] = size[i] * (1 - Math.exp(-(t + dt) / BLOOM_GROW_TAU));
        const fadeIn = Math.min(1, (t + dt) / BLOOM_FADE_IN);
        const u = Math.max(0, (t - BLOOM_FADE_FROM) / (BLOOM_LIFE - BLOOM_FADE_FROM));
        b.data[i * 4 + 3] = strength[i] * fadeIn * (1 - u * u * (3 - 2 * u));
      }
      return b;
    },
  };
  return b;
}

/** Points around the circle at which the waveform warps the arms. */
export const WARP_N = 64;
/** Seconds the warp takes to follow the waveform: arms wobble with the sound, never flicker. */
const WARP_TAU = 0.06;

/**
 * The waveform as WARP_N points around the circle, for warping the spiral arms. Each point is the
 * signed peak of its stretch of samples (so busy audio stays jagged), clamped to −1..1 and lightly
 * smoothed over time. Reads `waveform.length`; allocates nothing per step.
 */
export function createArmWarp() {
  const out = new Float32Array(WARP_N);
  return {
    /** @param {Float32Array} waveform @param {number} dt */
    step(waveform, dt) {
      const n = waveform.length;
      const a = 1 - Math.exp(-dt / WARP_TAU);
      for (let k = 0; k < WARP_N; k++) {
        const lo = Math.floor((k * n) / WARP_N);
        const hi = Math.floor(((k + 1) * n) / WARP_N);
        // The signed sample of largest magnitude: averaging would cancel busy audio to ~0.
        let v = 0;
        for (let i = lo; i < hi; i++) if (Math.abs(waveform[i]) > Math.abs(v)) v = waveform[i];
        out[k] += (Math.max(-1, Math.min(1, v)) - out[k]) * a;
      }
      return out;
    },
  };
}

/** Pattern options, in shader-index order. */
export const PATTERNS = ["spiral", "bullseye", "crumple", "shibori"];
/** Fabric options: white cotton shows through, or undyed areas are transparent. */
export const FABRICS = ["white", "none"];
/** Palette options; each is a list of dye colors (sRGB hex) in band order. */
export const PALETTES = ["rainbow", "sunset", "ocean", "neon"];
/** @type {Record<string, number[]>} */
const PALETTE_HEX = {
  rainbow: [0xd7192a, 0xf26b1d, 0xf7c815, 0x1f9e48, 0x1560bd, 0x6a2c91],
  sunset: [0xc2185b, 0xe53935, 0xfb8c00, 0xf9c80e, 0x7b1fa2],
  ocean: [0x0d2c6b, 0x1565c0, 0x19b5c4, 0x00897b, 0x3949ab],
  neon: [0xff1f8e, 0xff6a00, 0xffee00, 0x8cff1a, 0x00e5ff, 0x8a2cff],
};

/** @param {readonly string[]} options @param {unknown} name → index, 0 (the default) if unknown */
const indexOr0 = (options, name) => Math.max(0, options.indexOf(String(name)));

/** @param {unknown} name the Pattern param */
export function patternIndex(name) {
  return indexOr0(PATTERNS, name);
}

/** @param {unknown} name the Fabric param */
export function fabricIndex(name) {
  return indexOr0(FABRICS, name);
}

/**
 * Write a palette's dye colors (0–1 sRGB, 3 floats each) into `out`; unknown names → rainbow.
 * @param {unknown} name the Palette param
 * @param {Float32Array} out length ≥ MAX_COLORS × 3
 * @returns {number} how many colors
 */
export function paletteOf(name, out) {
  const hex = PALETTE_HEX[PALETTES[indexOr0(PALETTES, name)]];
  for (let i = 0; i < hex.length; i++) {
    out[i * 3] = ((hex[i] >> 16) & 255) / 255;
    out[i * 3 + 1] = ((hex[i] >> 8) & 255) / 255;
    out[i * 3 + 2] = (hex[i] & 255) / 255;
  }
  return hex.length;
}

/**
 * Band geometry, mirrored in shaders/tiedye/tiedye.frag (keep the constants in sync). Positions are
 * in unit-radius coordinates (1 = half the shorter screen side), centered.
 */
/** Times the palette repeats around the spiral. */
export const SPIRAL_ARMS = 2;
/** Times the palette repeats across the unit radius in bullseye, and how far rings drift per turn. */
export const RINGS = 1.8;
const RING_DRIFT = 1;
/** Shibori: width of one accordion fold (one pass through the palette) and stripe tilt per turn. */
export const FOLD = 1.6;
const FOLD_TILT = 0.25;

/**
 * Cumulative band edges: out[0] = 0, out[i + 1] = out[i] + w[i], out[n] = 1 (one full turn).
 * @param {Float32Array} w widths, summing to 1 @param {number} n @param {Float32Array} out length ≥ n + 1
 */
export function edgesFromWidths(w, n, out) {
  out[0] = 0;
  for (let i = 0; i < n; i++) out[i + 1] = out[i] + w[i];
  out[n] = 1;
  return out;
}

/**
 * Where a point falls in the palette, 0–1, before noise (crumple is noise-only, so it has no mirror
 * here and returns 0).
 * @param {number} pattern patternIndex
 * @param {number} x @param {number} y unit-radius coordinates
 * @param {number} twist spiral twist, turns across the unit radius
 * @param {number} turns rotation, turns
 */
export function bandCoord(pattern, x, y, twist, turns) {
  const r = Math.hypot(x, y);
  const fract = (/** @type {number} */ v) => v - Math.floor(v);
  if (pattern === 0) return fract(SPIRAL_ARMS * (Math.atan2(y, x) / (2 * Math.PI) + turns + twist * r));
  if (pattern === 1) return fract(RINGS * r - RING_DRIFT * turns);
  if (pattern === 3) {
    const th = 2 * Math.PI * FOLD_TILT * turns;
    const u = x * Math.cos(th) + y * Math.sin(th);
    return Math.abs(fract(u / FOLD + 0.5) * 2 - 1);
  }
  return 0;
}

/**
 * The band that palette position `t` falls in.
 * @param {number} t 0–1 @param {Float32Array} edges from edgesFromWidths @param {number} n
 */
export function bandOf(t, edges, n) {
  let i = 0;
  while (i < n - 1 && t >= edges[i + 1]) i++;
  return i;
}

/** Most a beat can strengthen the dye (full-frame, so it goes through the flash limiter). */
export const PULSE_MAX = 0.15;

/** Most the breathing (mids) deepens or thins the dye, also through the flash limiter. */
export const BREATH_MAX = 0.2;

/** Seconds for a beat's swell to decay. */
const PULSE_DECAY = 0.25;

/**
 * Global dye strength, 1 ± BREATH_MAX + up to PULSE_MAX: a beat swells it and it decays back, and
 * it breathes with the mids. It is full-frame, so it passes through the flash limiter (≤ 3 new rises per second with Reduce
 * flashing on).
 */
export function createIntensity() {
  const flash = createFlashLimiter();
  let kick = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset` @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} dt seconds @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @param {number} [breath] createBreath's `dye`, −1..1
     */
    step(onset, onsetStrength, dt, reduceFlashing, breath = 0) {
      kick = onset ? Math.max(kick, Math.min(1, 0.5 + Math.max(0, onsetStrength))) : kick * Math.exp(-dt / PULSE_DECAY);
      const b = Math.max(-1, Math.min(1, breath));
      return 1 + flash.step(PULSE_MAX * kick + BREATH_MAX * b, dt, reduceFlashing);
    },
  };
}

/**
 * @typedef {object} FlowInput
 * @property {number} rms `audio.rms`
 * @property {number} bassAtt `audio.bassAtt`
 * @property {boolean} onset `audio.onset`
 * @property {number} onsetStrength `audio.onsetStrength`
 * @property {number} bpm `audio.bpm` (0 until confident)
 * @property {number} beatPhase `audio.beatPhase`
 * @property {number} reactivity the Reactivity param
 * @property {number} motion the Motion param
 * @property {number} speed the Speed param
 * @property {boolean} reduceMotion `ctx.reduceMotion`
 */

/** Manifest default of the Motion param. */
export const DEFAULT_MOTION = 1;

/**
 * Speed × Motion, or the gentler REDUCED_SPEED under Reduce motion while both are at their
 * defaults (a value the user picked is respected).
 * @param {{ speed: number, motion: number, reduceMotion: boolean }} o
 */
export function motionScale(o) {
  if (o.reduceMotion && o.speed === DEFAULT_SPEED && o.motion === DEFAULT_MOTION) return REDUCED_SPEED;
  return Math.max(0, o.speed) * Math.max(0, o.motion);
}

/** Outward flow of the dye (unit radii per second at Speed 1): a calm drift, plus the music. */
const FLOW_BASE = 0.03;
const FLOW_ENERGY = 0.28;
/** Extra speed at the crest of a full-strength beat's surge (scaled by how loud the music is). */
const FLOW_SURGE = 0.6;
/** Fastest flow at Speed, Motion and Reactivity 1. */
export const FLOW_MAX = FLOW_BASE + FLOW_ENERGY + FLOW_SURGE;
/** Seconds for the energy behind the flow to follow the level. */
const ENERGY_TAU = 0.3;
/** A beat's kick decays over SURGE_DECAY; the surge follows it through two SURGE_ATTACK stages. */
const SURGE_DECAY = 0.25;
const SURGE_ATTACK = 0.05;
/** Without a confident tempo, onsets at least this strong count as beats. */
export const BEAT_STRENGTH = 0.6;
/** The kick of a tempo beat (on each beatPhase wrap). */
const TEMPO_KICK = 0.8;

/**
 * Loudness 0–1 from rms: −40 dBFS and below → 0, −10 dBFS and above → 1.
 * @param {number} rms
 */
export function loudness(rms) {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.max(0, Math.min(1, (db + 40) / 30));
}

/**
 * The dye's outward flow. `flow` is an odometer (unit radii travelled): the shader moves the
 * pattern and the dye record outward by it, so new dye appears at the knot and wicks outward.
 */
export function createFlow() {
  let kick = 0;
  let mid = 0;
  let phase = 0;
  const s = {
    /** True on the frame of a beat: a beatPhase wrap with a confident tempo, else a strong onset. */
    beat: false,
    /** The beat surge envelope, 0–1. */
    surge: 0,
    /** Smoothed loudness and bass, 0–1. */
    energy: 0,
    /** Current speed, unit radii per second. */
    speed: 0,
    /** Unwrapped distance travelled. */
    flow: 0,
    /** @param {number} dt @param {FlowInput} o */
    step(dt, o) {
      const level = Math.min(1, loudness(o.rms) + 0.3 * Math.max(0, Math.min(1, o.bassAtt - 1)));
      s.energy += (level - s.energy) * (1 - Math.exp(-dt / ENERGY_TAU));
      kick *= Math.exp(-dt / SURGE_DECAY);
      if (o.onset) kick = Math.max(kick, Math.max(0, Math.min(1, o.onsetStrength)));
      const tempo = o.bpm > 0;
      s.beat = tempo ? o.beatPhase < phase - 0.5 : o.onset && o.onsetStrength >= BEAT_STRENGTH;
      phase = tempo ? o.beatPhase : 0;
      if (tempo && s.beat) kick = Math.max(kick, TEMPO_KICK);
      const ka = 1 - Math.exp(-dt / SURGE_ATTACK);
      mid += (kick - mid) * ka;
      s.surge += (mid - s.surge) * ka;
      const react = Math.max(0, Math.min(2, o.reactivity));
      s.speed = motionScale(o) * (FLOW_BASE + react * (FLOW_ENERGY * s.energy + FLOW_SURGE * s.surge * (0.35 + 0.65 * s.energy)));
      s.flow += s.speed * dt;
      return s;
    },
  };
  return s;
}

/** Dye bands in the record (uniform array size in the shader). */
export const REC_CAP = 16;
/** No new band until the newest is this wide (unit radii): fast beats don't stack up slivers. */
export const MIN_BAND = 0.08;
/** A band this wide makes way for a fresh one even without a beat, so silence still renews. */
export const MAX_BAND = 0.6;

/**
 * The dye record: bands laid down at the knot (on beats) that ride outward on the flow, so the
 * cloth keeps a history of the music. Each band has a palette shift (which color its first arm
 * or ring takes; the shader adds it to the pattern's band index) and an ink strength. `data`
 * holds, newest first, per band: outer edge (its distance from the knot, unit radii), shift, ink,
 * 0 — ready for uniform4fv. The oldest band reaches to infinity. Nothing is allocated per step.
 */
export function createRecord() {
  const born = new Float64Array(REC_CAP);
  const shift = new Float32Array(REC_CAP);
  const ink = new Float32Array(REC_CAP);
  // A made-up history so the cloth starts fully dyed: one band per MAX_BAND, palette in order.
  for (let k = 0; k < REC_CAP; k++) {
    born[k] = -k * MAX_BAND * 0.5;
    shift[k] = k;
    ink[k] = 1;
  }
  let head = 0; // the newest band
  const r = {
    data: new Float32Array(REC_CAP * 4),
    /**
     * @param {number} flow the flow odometer @param {boolean} beat lay down a band?
     * @param {number} sh its palette shift @param {number} inkAmt its ink strength
     */
    step(flow, beat, sh, inkAmt) {
      const width = flow - born[head];
      if ((beat && width >= MIN_BAND) || width >= MAX_BAND) {
        head = (head + REC_CAP - 1) % REC_CAP;
        born[head] = flow;
        shift[head] = beat ? sh : shift[(head + 1) % REC_CAP] + 1;
        ink[head] = inkAmt;
      }
      for (let k = 0; k < REC_CAP; k++) {
        const i = (head + k) % REC_CAP;
        r.data[k * 4] = k === REC_CAP - 1 ? 1e6 : flow - born[i];
        r.data[k * 4 + 1] = shift[i];
        r.data[k * 4 + 2] = ink[i];
        r.data[k * 4 + 3] = 0;
      }
      return r;
    },
  };
  return r;
}

/** Seconds: how fast "now" follows each region, and how long "recently" is. */
const DOM_FAST = 0.05;
const DOM_SLOW = 1.5;

/**
 * Which palette region of the spectrum stands out right now: high in level and above its own
 * recent average (so a new instrument coming in wins over a steady bass). Silence keeps the last.
 */
export function createDominant() {
  const fast = new Float32Array(MAX_COLORS);
  const slow = new Float32Array(MAX_COLORS);
  let last = 0;
  return {
    /** @param {Float32Array} bands @param {number} n palette size @param {number} dt */
    step(bands, n, dt) {
      const af = 1 - Math.exp(-dt / DOM_FAST);
      const as = 1 - Math.exp(-dt / DOM_SLOW);
      let best = -1;
      let total = 0;
      let pick = last;
      for (let k = 0; k < n; k++) {
        const lo = Math.floor((k * bands.length) / n);
        const hi = Math.floor(((k + 1) * bands.length) / n);
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        e /= Math.max(1, hi - lo);
        fast[k] += (e - fast[k]) * af;
        slow[k] += (e - slow[k]) * as;
        total += fast[k];
        const score = (fast[k] * fast[k]) / (slow[k] + 0.05);
        if (score > best) {
          best = score;
          pick = k;
        }
      }
      if (total / n > 0.02) last = pick;
      return Math.min(last, n - 1);
    },
  };
}

/**
 * @typedef {object} MorphInput
 * @property {boolean} auto the Pattern param is "auto"
 * @property {number} home patternIndex of the Pattern param (used when not auto)
 * @property {boolean} beat a beat this frame (createFlow's `beat`)
 * @property {boolean} tempo the tempo is confident (`audio.bpm > 0`)
 * @property {number} energy createFlow's `energy`, 0–1
 * @property {boolean} reduceMotion `ctx.reduceMotion`
 */

/** The looks "auto" cycles through: a pattern and (for the spiral) its arm count. */
export const LOOKS = [
  { pattern: 0, arms: 2 },
  { pattern: 1, arms: 2 },
  { pattern: 0, arms: 3 },
  { pattern: 2, arms: 2 },
  { pattern: 0, arms: 1 },
  { pattern: 3, arms: 2 },
];
/** Beats in a phrase (8 bars of 4/4): with a confident tempo, the look changes once a phrase. */
export const PHRASE_BEATS = 32;
/** Seconds a morph takes (twice that under Reduce motion). */
export const MORPH_TIME = 4;
/** Without a tempo: seconds of loud music per phrase (silence runs the clock at SILENT_PACE). */
export const PHRASE_SECONDS = 16;
const SILENT_PACE = 0.35;
/** A sustained energy shift this big (fast vs slow average) ends a phrase early… */
const SHIFT = 0.25;
/** …once the phrase is at least this many seconds of clock old. */
const MIN_PHRASE = 4;
const SHIFT_FAST = 0.5;
const SHIFT_SLOW = 3;

/**
 * Pattern morphing for Pattern "auto": on phrase changes the cloth morphs from one look to the
 * next. `a` and `b` are pattern indices, `armsA`/`armsB` their spiral arm counts, and `mix` 0–1
 * how far the morph from a to b has got (0 = all a).
 */
export function createMorph() {
  let look = 0;
  let beats = 0;
  let clock = 0;
  let fast = NaN;
  let slow = NaN;
  const m = {
    a: 0,
    b: 0,
    armsA: 2,
    armsB: 2,
    mix: 0,
    /** True on the frame a phrase ends (also when not auto). */
    phrase: false,
    /** @param {number} dt @param {MorphInput} o */
    step(dt, o) {
      let phrase = false;
      if (Number.isNaN(fast)) fast = slow = o.energy;
      fast += (o.energy - fast) * (1 - Math.exp(-dt / SHIFT_FAST));
      slow += (o.energy - slow) * (1 - Math.exp(-dt / SHIFT_SLOW));
      if (o.tempo) {
        if (o.beat && ++beats >= PHRASE_BEATS) phrase = true;
      } else {
        clock += dt * (SILENT_PACE + (1 - SILENT_PACE) * Math.max(0, Math.min(1, o.energy)));
        phrase = clock >= PHRASE_SECONDS || (clock >= MIN_PHRASE && Math.abs(fast - slow) > SHIFT);
      }
      if (phrase) {
        beats = 0;
        clock = 0;
        slow = fast;
      }
      m.phrase = phrase;
      if (!o.auto) {
        m.a = m.b = o.home;
        m.armsA = m.armsB = 2;
        m.mix = 0;
        return m;
      }
      if (m.mix > 0 || phrase) {
        m.mix = Math.min(1, m.mix + dt / (o.reduceMotion ? 2 * MORPH_TIME : MORPH_TIME));
        if (m.mix >= 1) {
          look = (look + 1) % LOOKS.length;
          m.mix = 0;
        }
      }
      const next = (look + 1) % LOOKS.length;
      m.a = LOOKS[look].pattern;
      m.armsA = LOOKS[look].arms;
      m.b = LOOKS[next].pattern;
      m.armsB = LOOKS[next].arms;
      return m;
    },
  };
  return m;
}

/**
 * Rotate each dye color's hue by `hue` radians about the gray axis (clamped back into 0–1).
 * @param {Float32Array} base colors from paletteOf @param {number} n @param {number} hue
 * @param {Float32Array} out length ≥ n × 3
 */
export function driftPalette(base, n, hue, out) {
  const c = Math.cos(hue);
  const s = Math.sin(hue) / Math.sqrt(3);
  const k = (1 - c) / 3;
  const d = c + k;
  for (let i = 0; i < n; i++) {
    const r = base[i * 3];
    const g = base[i * 3 + 1];
    const b = base[i * 3 + 2];
    out[i * 3] = Math.max(0, Math.min(1, d * r + (k - s) * g + (k + s) * b));
    out[i * 3 + 1] = Math.max(0, Math.min(1, (k + s) * r + d * g + (k - s) * b));
    out[i * 3 + 2] = Math.max(0, Math.min(1, (k - s) * r + (k + s) * g + d * b));
  }
  return out;
}

/** Most the palette's hues drift from the chosen palette (radians): it stays in its family. */
export const MAX_HUE_DRIFT = 0.45;
/** Seconds per easing stage (two stages, so the drift starts and stops gently). */
const DRIFT_TAU = 2.5;

/**
 * Palette drift over a long listen: each phrase picks a new hue offset (seeded) and the palette
 * eases there over several seconds.
 * @param {number} seed
 */
export function createPaletteDrift(seed) {
  const rand = prng(seed);
  let target = 0;
  let mid = 0;
  let hue = 0;
  return {
    /** @param {number} dt @param {boolean} phrase @returns {number} hue offset, radians */
    step(dt, phrase) {
      if (phrase) {
        // Somewhere new, at least a third of the range away from where it was heading.
        let t = target;
        while (Math.abs(t - target) < MAX_HUE_DRIFT / 3) t = (2 * rand() - 1) * MAX_HUE_DRIFT;
        target = t;
      }
      const k = 1 - Math.exp(-dt / DRIFT_TAU);
      mid += (target - mid) * k;
      hue += (mid - hue) * k;
      return hue;
    },
  };
}

/** Seconds per breathing stage (two stages: no flicker). */
const BREATH_TAU = 0.2;
const BREATH_GAIN = 0.8;

/**
 * The cloth breathing with the mix: `dye` (−1..1) from the mids deepens or thins the dye
 * (createIntensity turns it into a flash-limited strength); `bleed` (0..1) from the treble loosens
 * the band edges.
 */
export function createBreath() {
  let dyeMid = 0;
  let bleedMid = 0;
  const b = {
    dye: 0,
    bleed: 0,
    /** @param {number} dt @param {number} midAtt @param {number} trebAtt @param {number} reactivity */
    step(dt, midAtt, trebAtt, reactivity) {
      const react = Math.max(0, Math.min(2, reactivity));
      const dye = Math.max(-1, Math.min(1, BREATH_GAIN * react * (midAtt - 1)));
      const bleed = Math.max(0, Math.min(1, BREATH_GAIN * react * (trebAtt - 1)));
      const k = 1 - Math.exp(-dt / BREATH_TAU);
      dyeMid += (dye - dyeMid) * k;
      b.dye += (dyeMid - b.dye) * k;
      bleedMid += (bleed - bleedMid) * k;
      b.bleed += (bleedMid - b.bleed) * k;
      return b;
    },
  };
  return b;
}
