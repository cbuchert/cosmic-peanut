// @ts-check
/**
 * Cascade — pure logic behind the waterfall (tested in cascade.test.js; the shaders mirror it).
 */
import { createFlashLimiter } from "./flash.js";

/**
 * |wave| resampled to `out.length` texels by point sampling with linear interpolation between the
 * two nearest samples — no box filter, so the waveform's jaggedness survives. Works for any input
 * length (read `.length`; 0 → all zero).
 * @param {ArrayLike<number>} wave
 * @param {Float32Array} out
 */
export function resampleAbs(wave, out) {
  const n = wave.length;
  const m = out.length;
  if (n === 0) return out.fill(0);
  const step = m > 1 ? (n - 1) / (m - 1) : 0;
  for (let i = 0; i < m; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = i0 + 1 < n ? i0 + 1 : i0;
    const f = x - i0;
    const a = Math.abs(wave[i0]);
    out[i] = a + (Math.abs(wave[i1]) - a) * f;
  }
  return out;
}

/** Seed smoothing time constant (s): a few frames, so ropes persist long enough to read as water. */
export const SEED_TAU = 0.035;

/** Auto-gain release time constant (s) and the level below which gain stops rising. */
export const GAIN_RELEASE = 4;
export const GAIN_FLOOR = 0.1;

/** Peak of the silence trickle, as a fraction of full flow. */
export const TRICKLE = 0.06;

/**
 * The flow floor: a few thin, slowly wandering streams, so silence is a trickle rather than a
 * dry, frozen lip.
 * @param {number} x 0–1 across the lip
 * @param {number} t seconds
 */
export function trickle(x, t) {
  const b = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (3 * x + 0.05 * t) + 1.3 * Math.sin(0.4 * t + 2 * x));
  const b2 = b * b;
  return TRICKLE * (0.08 + 0.92 * b2 * b2 * b2);
}

/**
 * The 1D flow seed across the lip, rebuilt once per frame from the newest waveform (allocates
 * nothing after creation).
 * @param {number} texels
 */
export function createSeed(texels) {
  const raw = new Float32Array(texels);
  const smooth = new Float32Array(texels);
  const values = new Float32Array(texels);
  let level = 0;
  let clock = 0;
  return {
    /** Mean of `values`: the total flow over the lip. */
    mean: 0,
    /** |waveform| resampled and smoothed over time, before gain. */
    smooth,
    /** The seed the GPU reads: flow strength per texel across the lip. */
    values,
    /** @param {ArrayLike<number>} wave @param {number} dt @param {number} surge */
    update(wave, dt, surge) {
      resampleAbs(wave, raw);
      const a = 1 - Math.exp(-dt / SEED_TAU);
      let top = 0;
      for (let i = 0; i < texels; i++) {
        smooth[i] += (raw[i] - smooth[i]) * a;
        if (smooth[i] > top) top = smooth[i];
      }
      // Auto-gain: instant attack, slow release, and a gain ceiling so real quiet stays thin.
      level = top > level ? top : level + (top - level) * (1 - Math.exp(-dt / GAIN_RELEASE));
      const gain = 1 / Math.max(level, GAIN_FLOOR);
      clock += dt;
      let sum = 0;
      for (let i = 0; i < texels; i++) {
        const tr = trickle(i / (texels - 1), clock);
        values[i] = tr + (1 - tr) * Math.min(1, smooth[i] * gain) * surge;
        sum += values[i];
      }
      this.mean = sum / texels;
    },
  };
}

/**
 * Inverse CDF of the seed, for sampling respawn positions across the lip. The seed is a piecewise
 * constant density (texel i covers [i/N, (i+1)/N)); `out[j]` is the lip position x in [0, 1] where
 * the cumulative flow reaches j / (M - 1). Built on the CPU once per frame (O(N + M)), so the
 * respawn shader draws x with one uniform random number and two texel fetches — cheaper than
 * rejection sampling, which would loop per particle. An all-zero seed gives a uniform lip.
 * @param {Float32Array} seed
 * @param {Float32Array} out
 */
export function buildInverseCdf(seed, out) {
  const n = seed.length;
  const m = out.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += seed[i] > 0 ? seed[i] : 0;
  if (!(total > 0)) {
    for (let j = 0; j < m; j++) out[j] = j / (m - 1);
    return out;
  }
  let i = 0;
  let before = 0; // cumulative flow before texel i
  for (let j = 0; j < m; j++) {
    const target = (j / (m - 1)) * total;
    let v = seed[i] > 0 ? seed[i] : 0;
    while (i < n - 1 && before + v < target) {
      before += v;
      i++;
      v = seed[i] > 0 ? seed[i] : 0;
    }
    const f = v > 0 ? Math.min(1, Math.max(0, (target - before) / v)) : 1;
    out[j] = (i + f) / n;
  }
  return out;
}

/**
 * Draw a lip position from `buildInverseCdf`'s table: linear interpolation between the two nearest
 * entries. The respawn shader does exactly this with two texelFetch calls.
 * @param {Float32Array} inv
 * @param {number} u uniform in [0, 1)
 */
export function sampleInverse(inv, u) {
  const p = u * (inv.length - 1);
  const j = Math.floor(p);
  const k = j + 1 < inv.length ? j + 1 : j;
  return inv[j] + (inv[k] - inv[j]) * (p - j);
}

/** Onset pulse decay time constant (s). */
export const PULSE_TAU = 0.15;

/** Bass surge range: the whole flow scales between these. */
export const SURGE_MIN = 0.4;
export const SURGE_MAX = 1.5;

/**
 * Per-frame audio envelopes that drive the whole fall: `surge` (bass swells the flow, bounded to
 * [SURGE_MIN, SURGE_MAX]) and `pulse` (an onset pushes a burst of water over the lip, 0–1).
 */
export function createEnvelopes() {
  let surge = 1;
  let kick = 0;
  const flash = createFlashLimiter();
  return {
    surge: 1,
    pulse: 0,
    /**
     * @param {{bassAtt: number, onset: boolean, onsetStrength: number}} audio
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing
     */
    step(audio, dt, reduceFlashing) {
      const b = audio.bassAtt > 0 ? audio.bassAtt : 0;
      const target = Math.min(SURGE_MAX, Math.max(SURGE_MIN, 0.3 + 0.6 * b));
      const tau = target > surge ? 0.06 : 0.35;
      surge += (target - surge) * (1 - Math.exp(-dt / tau));
      this.surge = surge;
      const k = audio.onset ? Math.min(1, 0.3 + 0.7 * Math.max(0, audio.onsetStrength)) : 0;
      kick = Math.max(k, kick * Math.exp(-dt / PULSE_TAU));
      // The pulse brightens and thickens the whole fall: a full-frame change, so it goes through
      // the photosensitivity limiter (≤ 3 new rises per second when reduceFlashing is on).
      this.pulse = flash.step(kick, dt, reduceFlashing);
    },
  };
}

/**
 * Fixed-timestep clock for the particle update (dt accumulator, as in Cosmic Peanut's push
 * scheduler): the sim advances in steps of exactly 1/hz seconds, so the fall looks identical at 60
 * and 120 Hz. After a stall, at most `maxSteps` run and the backlog is dropped (no spiral).
 * @param {number} hz steps per second
 * @param {number} maxSteps cap per frame
 */
export function createStepper(hz, maxSteps) {
  let acc = 0;
  return {
    /** @param {number} dt seconds since the previous frame @returns {number} steps to run now */
    step(dt) {
      acc += dt * hz;
      let n = Math.floor(acc + 1e-6);
      acc = Math.max(0, acc - n);
      if (n > maxSteps) {
        n = maxSteps;
        acc = 0;
      }
      return n;
    },
    reset() {
      acc = 0;
    },
  };
}

/** Density options (particle counts) and the default, sized for 60 fps at 1440p on an M1 Air. */
export const DENSITIES = { "16k": 16384, "32k": 32768, "64k": 65536 };
export const DEFAULT_DENSITY = "32k";

/**
 * Particle count and state-texture size for a density option: power-of-two width, just enough
 * rows. Called when the param changes (it allocates), never per frame.
 * @param {unknown} density
 */
export function stateSize(density) {
  const key = typeof density === "string" && density in DENSITIES ? density : DEFAULT_DENSITY;
  const count = DENSITIES[/** @type {keyof typeof DENSITIES} */ (key)];
  const width = 2 ** Math.ceil(Math.log2(Math.sqrt(count)));
  return { count, width, height: Math.ceil(count / width) };
}

/** Palette names in manifest order; the first is the default. */
export const PALETTES = ["glacier", "tropical", "moonlit", "mono"];

/** Four RGB stops per palette at t = 0, 1/3, 2/3, 1: deep/dim water → white highlight. */
const STOPS = {
  glacier: [0.05, 0.12, 0.25, 0.2, 0.45, 0.75, 0.6, 0.82, 1.0, 0.92, 0.97, 1.0],
  tropical: [0.02, 0.18, 0.18, 0.1, 0.55, 0.55, 0.5, 0.92, 0.85, 0.9, 1.0, 0.97],
  moonlit: [0.08, 0.07, 0.2, 0.3, 0.3, 0.6, 0.7, 0.72, 0.92, 0.95, 0.95, 1.0],
  mono: [0.15, 0.15, 0.15, 0.45, 0.45, 0.45, 0.75, 0.75, 0.75, 0.97, 0.97, 0.97],
};

/**
 * Copy a palette's four stops into `out` (12 floats, for a vec3[4] uniform). Unknown → glacier.
 * @param {unknown} name
 * @param {Float32Array} out
 */
export function paletteStops(name, out) {
  const key = typeof name === "string" && name in STOPS ? name : "glacier";
  const src = STOPS[/** @type {keyof typeof STOPS} */ (key)];
  for (let i = 0; i < 12; i++) out[i] = src[i];
  return out;
}

/**
 * Colour at t (0 = slow/old/dim water, 1 = fast fresh highlight): piecewise-linear through the
 * stops. Mirrors `ramp()` in the water shader.
 * @param {Float32Array} stops from paletteStops
 * @param {number} t
 * @param {Float32Array} out length ≥ 3
 */
export function paletteRamp(stops, t, out) {
  const p = Math.min(1, Math.max(0, t)) * 3;
  const k = Math.min(2, Math.floor(p));
  const f = p - k;
  for (let c = 0; c < 3; c++) out[c] = stops[k * 3 + c] + (stops[k * 3 + 3 + c] - stops[k * 3 + c]) * f;
  return out;
}

/** Manifest defaults of the motion params (a test keeps them in sync with tidalviz.json). */
export const DEFAULTS = { spray: 0.6, turbulence: 0.4 };

/**
 * Effective spray and turbulence. With macOS Reduce motion, params still at their defaults get
 * calmer values (less bouncing spray, a steadier curtain); anything the user set is respected.
 * @param {{spray: unknown, turbulence: unknown}} params
 * @param {boolean} reduceMotion
 * @param {{spray: number, turbulence: number}} out
 */
export function motionParams(params, reduceMotion, out) {
  const spray = Number(params.spray);
  const turb = Number(params.turbulence);
  out.spray = reduceMotion && spray === DEFAULTS.spray ? spray * 0.4 : spray;
  out.turbulence = reduceMotion && turb === DEFAULTS.turbulence ? turb * 0.3 : turb;
  return out;
}
