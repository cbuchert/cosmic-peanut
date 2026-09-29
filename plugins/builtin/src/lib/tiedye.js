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
 * @property {number} bassAtt `audio.bassAtt`
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
      const gentle = o.reduceMotion && o.speed === DEFAULT_SPEED;
      const speed = gentle ? REDUCED_SPEED : o.speed;
      const bass = Math.max(-1, Math.min(1, o.bassAtt - 1));
      const react = Math.max(0, Math.min(2, o.reactivity)) / 2;
      const twist = o.twist * (1 + TWIST_DEPTH * react * bass);
      const target = speed * (BASE_RATE + BASS_RATE * react * (1 + bass));
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
export const RINGS = 2.5;
const RING_DRIFT = 1;
/** Shibori: width of one accordion fold (one pass through the palette) and stripe tilt per turn. */
export const FOLD = 0.4;
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

/** Seconds for a beat's swell to decay. */
const PULSE_DECAY = 0.25;

/**
 * Global dye strength, 1 to 1 + PULSE_MAX: a beat swells it, and it decays back. The swell is
 * full-frame, so it passes through the flash limiter (≤ 3 new rises per second with Reduce
 * flashing on).
 */
export function createIntensity() {
  const flash = createFlashLimiter();
  let kick = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset` @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} dt seconds @param {boolean} reduceFlashing `ctx.reduceFlashing`
     */
    step(onset, onsetStrength, dt, reduceFlashing) {
      kick = onset ? Math.max(kick, Math.min(1, 0.5 + Math.max(0, onsetStrength))) : kick * Math.exp(-dt / PULSE_DECAY);
      return 1 + PULSE_MAX * flash.step(kick, dt, reduceFlashing);
    },
  };
}
