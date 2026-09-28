// @ts-check
/**
 * Cascade — pure logic behind the waterfall (tested in cascade.test.js; the shaders mirror it).
 */
import { createFlashLimiter } from "./flash.js";

/**
 * |wave| resampled to `out.length` texels by point sampling with linear interpolation between the
 * two nearest samples — no box filter, so the waveform's jaggedness survives. Works for any input
 * length (read `.length`; 0 → all zero). Optionally only `length` samples from `start`.
 * @param {ArrayLike<number>} wave
 * @param {Float32Array} out
 * @param {number} [start]
 * @param {number} [length]
 */
export function resampleAbs(wave, out, start = 0, length = wave.length - start) {
  const n = Math.min(wave.length, start + length);
  const m = out.length;
  if (n - start <= 0) return out.fill(0);
  const step = m > 1 ? (n - 1 - start) / (m - 1) : 0;
  for (let i = 0; i < m; i++) {
    const x = start + i * step;
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
      // Trigger in the oldest quarter, show the rest: the window keeps a fixed length.
      const search = wave.length >> 2;
      resampleAbs(wave, raw, triggerIndex(wave, search), wave.length - search);
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
        // Squared: the peaks of |w| pour ropes, the troughs between them run thin.
        const g = Math.min(1, smooth[i] * gain);
        values[i] = tr + (1 - tr) * g * g * surge;
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

/** Density options (particle counts) and the default, sized for 60 fps at 1440p on an M1 Air (64k: ~2 ms GPU filling the window). */
export const DENSITIES = { "16k": 16384, "32k": 32768, "64k": 65536 };
export const DEFAULT_DENSITY = "64k";

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
 * @param {Readonly<Record<string, unknown>>} params
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

/**
 * Oscilloscope trigger: the index in [1, search) of the steepest rising zero crossing (slope
 * measured over a few samples, so hiss doesn't win), or 0 if there is none. Starting the window
 * there pins periodic content in place from frame to frame, so the ropes it seeds persist instead
 * of sliding across the lip with the waveform's phase.
 * @param {ArrayLike<number>} wave
 * @param {number} search
 */
export function triggerIndex(wave, search) {
  const n = wave.length;
  const end = Math.min(search, n - 3);
  let best = 0;
  let bestSlope = 0;
  for (let i = 3; i < end; i++) {
    if (wave[i - 1] <= 0 && wave[i] > 0) {
      const slope = wave[i + 2] - wave[i - 3];
      if (slope > bestSlope) {
        bestSlope = slope;
        best = i;
      }
    }
  }
  return best;
}

/** Where the lip sits: just above the top edge, so the pour enters from outside the window. */
export const LIP_TOP = 1.005;
/** How far the full-width lip reaches past each side (fraction of the half-width), so turbulence
 * and fan-out carry water in from off-screen instead of opening a gap at the edges. */
export const OVERSCAN = 0.04;
/** The plunge pool: splashes start just above the bottom edge (so spray has room to show). */
export const POOL_Y = 0.035;
/** Water that doesn't splash falls on through the bottom edge and dies below this. */
export const FLOOR_Y = -0.05;

/** Reference canvas (1440p) for the pixel-size scale factors. */
const REF_W = 2560;
const REF_H = 1440;
/** Streak half-width at the reference canvas (px) and the streak length (s of motion). */
const LINE_WIDTH = 1.1;
const STREAK = 0.1;
/** Mist buffer downscale and blob size as a fraction of that buffer's geometric-mean side. */
export const MIST_DIV = 4;
const MIST_BLOB = 1 / 16;
/** Bounds on the canvas-size brightness compensation. */
export const GAIN_MIN = 0.3;
export const GAIN_MAX = 2;

/**
 * @typedef {object} Layout
 * @property {number} halfW half the canvas width, height units
 * @property {number} lipHalf half the lip's span
 * @property {number} lipY lip height
 * @property {number} poolY plunge-pool height (splashes start here)
 * @property {number} floorY water that didn't splash dies below this
 * @property {number} killX particles past ±killX are gone
 * @property {number} streak seconds of motion a streak spans (so a fixed fraction of the canvas)
 * @property {number} lineWidth streak half-width, px
 * @property {number} mistW mist buffer size, px
 * @property {number} mistH
 * @property {number} mistSize mist point size, mist-buffer px
 * @property {number} gain brightness compensation for the canvas size (1 at 1440p landscape)
 */

/**
 * The fall's layout in height units (y: 0 bottom .. 1 top, x centred, ±halfW at the side edges),
 * from the canvas size and the width/height params. By default the lip spans the full width just
 * above the top edge and the pool sits on the bottom edge, for any aspect; `width` narrows the lip
 * and `height` shortens the drop, both as fractions. Writes into `out` (allocates nothing).
 * @param {number} w canvas width (px)
 * @param {number} h canvas height (px)
 * @param {Readonly<Record<string, unknown>>} params `width` and `height`, 0–1
 * @param {Partial<Layout>} out
 * @returns {Layout}
 */
export function layout(w, h, params, out) {
  const o = /** @type {Layout} */ (out);
  const halfW = w / h / 2;
  o.halfW = halfW;
  o.lipHalf = halfW * (1 + OVERSCAN) * Number(params.width);
  o.lipY = POOL_Y + (LIP_TOP - POOL_Y) * Number(params.height);
  o.poolY = POOL_Y;
  o.floorY = FLOOR_Y;
  // Past this (either side) a particle is gone: just beyond the widest spawn and the canvas edge.
  o.killX = Math.max(o.lipHalf, halfW) + 0.05;
  o.streak = STREAK;
  o.lineWidth = LINE_WIDTH * Math.max(1, Math.sqrt((w * h) / (REF_W * REF_H)));
  o.mistW = Math.max(1, Math.round(w / MIST_DIV));
  o.mistH = Math.max(1, Math.round(h / MIST_DIV));
  o.mistSize = Math.sqrt(o.mistW * o.mistH) * MIST_BLOB;
  // Streak length and the drop both scale with h, so additive brightness per unit of canvas goes
  // as lineWidth / w: hold it at the reference level.
  const want = (LINE_WIDTH / REF_W) * (w / o.lineWidth);
  o.gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, want));
  return o;
}

/**
 * Lip position (height units, centred) for a draw `xs` in [0, 1] from the inverse CDF. Mirrors the
 * respawn in update.frag.
 * @param {number} xs
 * @param {number} lipHalf
 */
export function lipX(xs, lipHalf) {
  return (xs * 2 - 1) * lipHalf;
}
