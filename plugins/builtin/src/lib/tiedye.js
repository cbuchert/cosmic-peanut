// @ts-check
/** Tie-Dye's pure logic. */

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
