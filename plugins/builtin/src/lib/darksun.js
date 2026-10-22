// @ts-check
/**
 * Dark Sun's pure logic, tested in darksun.test.js: the sun's rim and corona, the travelling
 * diamond ring, the beam, the flash-limited surge, layout, palettes and Reduce-motion defaults.
 * Every `step` is frame-rate independent and allocates nothing.
 */
import { createFlashLimiter } from "./flash.js";

/** Rim glow (multiplier) and corona reach (in sun radii past the rim) at rest and at full swell. */
export const RIM_MIN = 0.5;
export const RIM_MAX = 1.5;
export const REACH_MIN = 0.6;
export const REACH_MAX = 2.2;
/** The disc's swell at full level (fraction of its radius). */
export const SWELL = 0.1;
/** Time constant (s) of the sun's swell: bass breathes it, kicks never pop it. */
const SUN_TAU = 0.25;

/** Clamp to 0–hi; NaN → 0. @param {number} v @param {number} hi */
const clamp = (v, hi) => (v > 0 ? (v < hi ? v : hi) : 0);

/**
 * The sun's swell from `audio.bassAtt` (1 = average bass): drive = reactivity · 0.4 · bassAtt ·
 * (0.2 + 0.8 · energy), capped at 1, smoothed with SUN_TAU. The energy gate (createEnergy, default
 * 1) keeps a quiet passage's sun calm, as bassAtt is relative. Reactivity 0 leaves the sun at rest.
 * `scale` is the disc's radius multiplier, up to 1 + SWELL.
 */
export function createSun() {
  const s = {
    /** 0–1 smoothed swell. */
    level: 0,
    rim: RIM_MIN,
    reach: REACH_MIN,
    scale: 1,
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} [energy] createEnergy's value, 0–1
     * @returns {number} the swell, 0–1
     */
    step(bassAtt, dt, reactivity, energy = 1) {
      const gate = 0.2 + 0.8 * clamp(energy, 1);
      const drive = clamp(0.4 * clamp(reactivity, 2) * clamp(bassAtt, 3) * gate, 1);
      s.level += (drive - s.level) * (1 - Math.exp(-dt / SUN_TAU));
      s.rim = RIM_MIN + (RIM_MAX - RIM_MIN) * s.level;
      s.reach = REACH_MIN + (REACH_MAX - REACH_MIN) * s.level;
      s.scale = 1 + SWELL * s.level;
      return s.level;
    },
  };
  return s;
}

/** Diamond ring's travel (rad/s) at rest; energy adds up to DIAMOND_BOOST × that. */
export const DIAMOND_RATE = 0.12;
const DIAMOND_BOOST = 1;
/** Where it starts (rad, counter-clockwise from +x, y up): low on the right, like the cover. */
export const DIAMOND_START = -0.85;

/**
 * The brightest point on the rim, travelling slowly around it. Energy (e.g. `audio.bassAtt`,
 * 1 = average) is clamped to 0–2 and smoothed over half a second, then speeds it by up to
 * DIAMOND_BOOST; `motion` scales the whole rate (Reduce motion halves it).
 */
export function createDiamond() {
  const d = {
    /** Radians, unwrapped. */
    angle: DIAMOND_START,
    energy: 0,
    /**
     * @param {number} energy
     * @param {number} dt seconds
     * @param {number} motion rate scale, ≥ 0
     */
    step(energy, dt, motion) {
      d.energy += (clamp(energy, 2) / 2 - d.energy) * (1 - Math.exp(-dt / 0.5));
      d.angle += DIAMOND_RATE * (1 + DIAMOND_BOOST * d.energy) * clamp(motion, 4) * dt;
      return d.angle;
    },
  };
  return d;
}

/** Beam width (multiplier of its base width) and brightness, [rest, full]. */
export const BEAM_WIDTH = [1, 3];
export const BEAM_BRIGHT = [0.35, 1];
/** The beam's pulse follows its drive with a quick attack and an easy release (s). */
const BEAM_ATTACK = 0.03;
const BEAM_RELEASE = 0.3;

/**
 * The narrow light falling from the range's centre. Drive = reactivity · (0.35 · bass · (0.15 +
 * 0.85 · energy) + 1.5 · rms) (bass is `audio.bass`, 1 = average; rms is `audio.rms`), capped at 1.
 */
export function createBeam() {
  const b = {
    level: 0,
    width: BEAM_WIDTH[0],
    bright: BEAM_BRIGHT[0],
    /**
     * @param {number} bass `audio.bass`
     * @param {number} rms `audio.rms`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} [energy] createEnergy's value, 0–1 (default 1): gates the relative bass
     */
    step(bass, rms, dt, reactivity, energy = 1) {
      const bassIn = 0.35 * clamp(bass, 3) * (0.15 + 0.85 * clamp(energy, 1));
      const drive = clamp(clamp(reactivity, 2) * (bassIn + 1.5 * clamp(rms, 1)), 1);
      const tau = drive > b.level ? BEAM_ATTACK : BEAM_RELEASE;
      b.level += (drive - b.level) * (1 - Math.exp(-dt / tau));
      b.width = BEAM_WIDTH[0] + (BEAM_WIDTH[1] - BEAM_WIDTH[0]) * b.level;
      b.bright = BEAM_BRIGHT[0] + (BEAM_BRIGHT[1] - BEAM_BRIGHT[0]) * b.level;
      return b.level;
    },
  };
  return b;
}

/** Surge decay rate (1/s): a beat's flare is mostly gone in half a second. */
const SURGE_DECAY = 7;

/**
 * Beat flare for the beam and the horizon glow (a full-width brightness change, so it goes through
 * the shared flash limiter): an onset lifts the envelope to 0.5 + 0.5 · strength, which then decays
 * at SURGE_DECAY. With `reduceFlashing` at most 3 new flares start per second.
 */
export function createSurge() {
  const flash = createFlashLimiter();
  let env = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @returns {number} 0–1
     */
    step(onset, strength, dt, reduceFlashing) {
      env *= Math.exp(-dt * SURGE_DECAY);
      if (onset) {
        const k = 0.5 + 0.5 * clamp(strength, 1);
        if (k > env) env = k;
      }
      return flash.step(env, dt, reduceFlashing);
    },
  };
}

/**
 * @typedef {object} Layout drawing-buffer pixels, y down from the top
 * @property {number} horizon y of the horizon line
 * @property {number} sunX
 * @property {number} sunY
 * @property {number} sunR disc radius
 * @property {number} rangeHalf half-width of the inverted range
 * @property {number} rangeDepth depth of a full-level peak below the horizon
 * @property {number} beamWidth the beam's base half-width
 * @property {number} unit min(w, h)
 */

/**
 * The cover's composition, scaled by min(w, h) so it holds in landscape, portrait and small
 * windows: horizon at half height; the sun centred at 22 % from the top at the default rise (28 %
 * sunk … 17 % risen; lower if its swollen rim would clip the top edge); the range centred, `rangeWidth` of the width across, hanging up to
 * 0.28 · min(w, h) · rangeDepth (typical levels sit well under 1) (never more than 80 % of the way to the bottom).
 * @param {number} w
 * @param {number} h
 * @param {{ sunSize: number, rangeWidth: number, rangeDepth: number, rise?: number }} o rise: createSunMood's
 *   rise, 0–1 (default 0.5, the cover's height)
 * @param {Layout} out
 * @returns {Layout}
 */
export function layout(w, h, o, out) {
  const unit = Math.min(w, h);
  const horizon = 0.5 * h;
  const r = 0.085 * unit * o.sunSize;
  out.unit = unit;
  out.horizon = horizon;
  out.sunX = 0.5 * w;
  out.sunR = r;
  // The sun rises with the song: 0.28 h at rise 0 (sunk toward the horizon), 0.17 h at rise 1,
  // kept clear of the top edge and well above the horizon even fully swollen.
  const rise = o.rise === undefined ? 0.5 : clamp(o.rise, 1);
  const big = r * (1 + SWELL);
  out.sunY = Math.min(Math.max((0.28 - 0.11 * rise) * h, 1.2 * big), horizon - 1.3 * big);
  out.rangeHalf = 0.5 * o.rangeWidth * w;
  out.rangeDepth = Math.min(0.28 * unit * o.rangeDepth, 0.8 * (h - horizon));
  out.beamWidth = 0.004 * unit;
  return out;
}

/** Manifest defaults and ranges of the number params (tests/test_builtin_manifests.py pins them). */
export const DEFAULTS = { reactivity: 1, rangeWidth: 0.5, rangeDepth: 1, beam: 1, sunSize: 1 };
/** @type {Record<keyof typeof DEFAULTS, [number, number]>} */
export const RANGES = {
  reactivity: [0, 2],
  rangeWidth: [0.3, 0.7],
  rangeDepth: [0.3, 2],
  beam: [0, 2],
  sunSize: [0.5, 1.6],
};
const KEYS = /** @type {(keyof typeof DEFAULTS)[]} */ (Object.keys(DEFAULTS));
/** Under Reduce motion: drift/rotation scale, and the reactivity used while it's at its default. */
export const REDUCED_MOTION = 0.4;
export const REDUCED_REACTIVITY = 0.6;

/**
 * @typedef {object} Resolved
 * @property {number} reactivity
 * @property {number} rangeWidth
 * @property {number} rangeDepth
 * @property {number} beam
 * @property {number} sunSize
 * @property {number} motion scale for every slow drift and rotation
 */

/**
 * Number params clamped to their ranges (NaN → default), plus a motion scale. Reduce motion slows
 * all drift and, while Reactivity sits at its default, softens it; a value the user chose stays.
 * @param {Readonly<Record<string, unknown>>} p `ctx.params`
 * @param {boolean} reduceMotion
 * @param {Resolved} out
 */
export function resolveParams(p, reduceMotion, out) {
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i];
    const v = Number(p[k]);
    const [lo, hi] = RANGES[k];
    out[k] = Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : DEFAULTS[k];
  }
  out.motion = reduceMotion ? REDUCED_MOTION : 1;
  if (reduceMotion && out.reactivity === DEFAULTS.reactivity) out.reactivity = REDUCED_REACTIVITY;
  return out;
}

/** Colour slots of a palette (vec3 each), in order. */
const SLOTS = ["SKY_TOP", "SKY_LOW", "GROUND", "WASH", "GLOW", "RIM", "DISC", "CORONA"];
/** @type {Record<string, number[][]>} same order as SLOTS */
const TABLE = {
  // The cover: ash-grey sky over salmon, dark mauve-brown ground, near-white light.
  dusk: [
    [0.3, 0.3, 0.32],
    [0.93, 0.5, 0.52],
    [0.16, 0.115, 0.115],
    [0.34, 0.25, 0.25],
    [1, 0.93, 0.92],
    [1, 0.88, 0.86],
    [0.07, 0.06, 0.065],
    [0.85, 0.36, 0.36],
  ],
  ash: [[0.29, 0.29, 0.29], [0.62, 0.62, 0.62], [0.12, 0.12, 0.12], [0.26, 0.26, 0.26], [0.97, 0.97, 0.97], [0.95, 0.95, 0.95], [0.06, 0.06, 0.06], [0.6, 0.6, 0.6]],
  teal: [[0.16, 0.22, 0.26], [0.45, 0.78, 0.78], [0.06, 0.12, 0.13], [0.14, 0.26, 0.27], [0.88, 1, 0.98], [0.85, 1, 0.97], [0.04, 0.07, 0.08], [0.3, 0.7, 0.7]],
  gold: [[0.3, 0.26, 0.22], [0.96, 0.7, 0.4], [0.16, 0.11, 0.07], [0.33, 0.23, 0.15], [1, 0.95, 0.84], [1, 0.92, 0.75], [0.07, 0.05, 0.04], [0.9, 0.55, 0.25]],
};

/** Palette names (manifest order) and slot indices (vec3 index into a palette buffer). */
export const PALETTES = {
  names: Object.keys(TABLE),
  SIZE: SLOTS.length * 3,
  SKY_TOP: 0,
  SKY_LOW: 1,
  GROUND: 2,
  WASH: 3,
  GLOW: 4,
  RIM: 5,
  DISC: 6,
  CORONA: 7,
};

/**
 * Fill `out` (PALETTES.SIZE floats, 0–1) with a palette's colours; unknown names → dusk.
 * @param {unknown} name
 * @param {Float32Array} out
 */
export function palette(name, out) {
  const t = TABLE[typeof name === "string" && Object.hasOwn(TABLE, name) ? name : "dusk"];
  for (let i = 0; i < t.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = t[i][c];
  return out;
}

/** Backdrop "none" leaves sky and ground transparent; anything else paints them. @param {unknown} b */
export function isPainted(b) {
  return b !== "none";
}

/** Horizon glow at rest and at full breath; a surge adds up to 0.5 on top. */
export const GLOW_RANGE = [0.5, 1];
/** Breathing time constant (s). */
const GLOW_TAU = 0.4;

/**
 * The horizon glow: breathes with `audio.midAtt` (1 = average; drive = reactivity · 0.5 · midAtt ·
 * (0.15 + 0.85 · energy), capped at 1, smoothed over GLOW_TAU), plus half the surge, which the caller has already passed
 * through the flash limiter.
 */
export function createGlow() {
  const g = {
    level: 0,
    value: GLOW_RANGE[0],
    /**
     * @param {number} midAtt `audio.midAtt`
     * @param {number} surge 0–1, flash-limited
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} [energy] createEnergy's value, 0–1 (default 1): gates the relative mids
     */
    step(midAtt, surge, dt, reactivity, energy = 1) {
      const gate = 0.15 + 0.85 * clamp(energy, 1);
      const drive = clamp(0.5 * clamp(reactivity, 2) * clamp(midAtt, 3) * gate, 1);
      g.level += (drive - g.level) * (1 - Math.exp(-dt / GLOW_TAU));
      g.value = GLOW_RANGE[0] + (GLOW_RANGE[1] - GLOW_RANGE[0]) * g.level + 0.5 * clamp(surge, 1);
      return g.value;
    },
  };
  return g;
}

/** Loudness span (dBFS of `audio.rms`) mapped to 0–1: a quiet passage near 0, mastered music near 1. */
export const LOUD_DB = [-42, -14];

/**
 * How loud the music is, absolutely: rms in dB across LOUD_DB, clamped to 0–1 (NaN → 0). The
 * host's bass/mid/treb are relative to the last few seconds, so a long quiet passage reads as
 * "average" there; this is what keeps quiet passages calm.
 * @param {number} rms `audio.rms`
 */
export function loudness(rms) {
  if (!(rms > 0)) return 0;
  return clamp((20 * Math.log10(rms) - LOUD_DB[0]) / (LOUD_DB[1] - LOUD_DB[0]), 1);
}

/** Energy follower time constants (s): it swells within a beat or two and settles over a bar. */
const ENERGY_ATTACK = 0.2;
const ENERGY_RELEASE = 0.8;

/** The music's energy: loudness() smoothed, quick up and slower down. 0–1. */
export function createEnergy() {
  const e = {
    value: 0,
    /** @param {number} rms `audio.rms` @param {number} dt seconds */
    step(rms, dt) {
      const x = loudness(rms);
      e.value += (x - e.value) * (1 - Math.exp(-dt / (x > e.value ? ENERGY_ATTACK : ENERGY_RELEASE)));
      return e.value;
    },
  };
  return e;
}

/**
 * A beat's kick to the landscape, 0–1: reactivity · onset strength · an energy gate that leaves a
 * quiet passage's beats a nudge (0.08 + 0.92 · energy^1.5). 0 without an onset; NaN reads as 0.
 * @param {boolean} onset `audio.onset`
 * @param {number} strength `audio.onsetStrength`
 * @param {number} energy createEnergy's value, 0–1
 * @param {number} reactivity 0–2
 */
export function beatHit(onset, strength, energy, reactivity) {
  if (!onset) return 0;
  const g = 0.08 + 0.92 * clamp(energy, 1) ** 1.5;
  return clamp(clamp(reactivity, 2) * clamp(strength, 1) * g, 1);
}

/**
 * The washes' flow, in drift-clock units per second: REST in silence, up to REST + GAIN when loud,
 * plus up to SURGE for a moment after a beat; MAX bounds it.
 */
export const FLOW = { REST: 0.7, GAIN: 3.3, SURGE: 3, MAX: 7 };
/** Flow speed easing (s) and the beat surge's decay rate (1/s). */
const FLOW_TAU = 0.12;
const FLOW_DECAY = 4;

/**
 * The sky and ground washes' drift clock (`clock`, fed to the backdrop shader as its time) and
 * turbulence (`turb`, 0–1: how hard the washes are warped). Drive = reactivity · energy; a beat
 * (beatHit) surges both and they ease back. `motion` (Reduce motion) scales the clock.
 */
export function createFlow() {
  let env = 0;
  const f = {
    clock: 0,
    speed: FLOW.REST,
    turb: 0.2,
    /**
     * @param {number} energy 0–1
     * @param {number} hit beatHit, 0–1
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} motion ≥ 0
     */
    step(energy, hit, dt, reactivity, motion) {
      env *= Math.exp(-dt * FLOW_DECAY);
      const h = clamp(hit, 1);
      if (h > env) env = h;
      const drive = clamp(clamp(reactivity, 2) * clamp(energy, 1), 1);
      const k = 1 - Math.exp(-dt / FLOW_TAU);
      const target = Math.min(FLOW.MAX, FLOW.REST + FLOW.GAIN * drive + FLOW.SURGE * env);
      f.speed += (target - f.speed) * k;
      f.turb += (clamp(0.2 + 0.6 * drive + 0.4 * env, 1) - f.turb) * k;
      f.clock += clamp(motion, 4) * f.speed * dt;
      return f;
    },
  };
  return f;
}

/** Sky brightness multiplier, [sparse, open]; the cover's sky is 1. */
export const SKY_BRIGHT = [0.85, 1.15];
/** Spectral centroid (0–1 of Nyquist) read as dark → bright: most music sits in this span. */
const CENTROID = [0.03, 0.2];
/** Sky tone easing (s): the colour moves with the song's sections, not with single notes. */
const SKY_TAU = 1;

/**
 * The sky's colour temperature (`warm`, 0 = cool ash … 1 = warm pink; 0.5 = the cover) and
 * brightness (`bright`, SKY_BRIGHT) from spectral brightness (`audio.centroid`) and energy. Both
 * ease over SKY_TAU, scaled about the cover's tone by reactivity (0 = the cover); the brightness
 * target goes through the shared flash limiter first (a full-frame brightness change), so even a
 * strobing input starts at most 3 brightenings a second.
 */
export function createSkyTone() {
  const flash = createFlashLimiter();
  let w = 0.5;
  let b = 1;
  const t = {
    warm: 0.5,
    bright: 1,
    /**
     * @param {number} centroid `audio.centroid`
     * @param {number} energy createEnergy's value, 0–1
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     */
    step(centroid, energy, dt, reactivity, reduceFlashing) {
      const r = clamp(reactivity, 2);
      const c = clamp((centroid - CENTROID[0]) / (CENTROID[1] - CENTROID[0]), 1);
      const e = clamp(energy, 1);
      const k = 1 - Math.exp(-dt / SKY_TAU);
      w += (clamp(0.5 + r * (0.6 * c + 0.4 * e - 0.5), 1) - w) * k;
      const span = (SKY_BRIGHT[1] - SKY_BRIGHT[0]) / 2;
      const target = 1 + span * Math.max(-1, Math.min(1, r * 2 * (0.7 * e + 0.3 * c - 0.5)));
      b += (flash.step(target, dt, reduceFlashing) - b) * k;
      t.warm = w;
      t.bright = b;
      return t;
    },
  };
  return t;
}

/** How quickly (s) the breath fades in once the host has a tempo, and out when it loses it. */
const BREATH_TAU = 0.6;

/**
 * A breath in time with the beat for the landscape between beats: 0.5 + 0.5 · cos(2π · beatPhase)
 * (1 on the beat), weighted by reactivity · energy^1.5 and by whether the host has a tempo
 * (`bpm` > 0). While the tempo is lost the last phase holds and the weight fades, so nothing jumps.
 */
export function createBreath() {
  let weight = 0;
  let phase = 0;
  const b = {
    value: 0,
    /**
     * @param {number} bpm `audio.bpm` (0 = no tempo yet)
     * @param {number} beatPhase `audio.beatPhase`, 0–1
     * @param {number} energy 0–1
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(bpm, beatPhase, energy, dt, reactivity) {
      const sure = bpm > 0 && Number.isFinite(beatPhase);
      if (sure) phase = beatPhase;
      const target = sure ? clamp(clamp(reactivity, 2) * clamp(energy, 1) ** 1.5, 1) : 0;
      weight += (target - weight) * (1 - Math.exp(-dt / BREATH_TAU));
      b.value = clamp(weight * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase)), 1);
      return b.value;
    },
  };
  return b;
}

/** Ripples alive at once, the smallest beatHit that spawns one, and their fade rate (1/s). */
export const RIPPLES = 3;
const RIPPLE_MIN = 0.05;
const RIPPLE_DECAY = 1.6;

/**
 * Beat ripples: each beatHit above RIPPLE_MIN starts one (age 0, amplitude = the hit), replacing
 * the oldest of RIPPLES. They age in seconds and fade at RIPPLE_DECAY. `rings` is
 * [age, amplitude] × RIPPLES, ready for a vec2 uniform array; the shader turns age into radius.
 */
export function createRipples() {
  const rings = new Float32Array(2 * RIPPLES).fill(0);
  for (let k = 0; k < RIPPLES; k++) rings[2 * k] = 1e3;
  const r = {
    rings,
    /** @param {number} hit beatHit, 0–1 @param {number} dt seconds */
    step(hit, dt) {
      const fade = Math.exp(-dt * RIPPLE_DECAY);
      let oldest = 0;
      for (let k = 0; k < RIPPLES; k++) {
        rings[2 * k] += dt;
        rings[2 * k + 1] *= fade;
        if (rings[2 * k] > rings[2 * oldest]) oldest = k;
      }
      const h = clamp(hit, 1);
      if (h >= RIPPLE_MIN) {
        rings[2 * oldest] = 0;
        rings[2 * oldest + 1] = h;
      }
      return rings;
    },
  };
  return r;
}

/** The diamond spike's decay rate (1/s). */
const SPIKE_DECAY = 7;

/**
 * The diamond ring's beat spike: a beatHit lifts the envelope to the hit, which decays at
 * SPIKE_DECAY; the shared flash limiter lets at most 3 spikes a second start under reduceFlashing.
 */
export function createSpike() {
  const flash = createFlashLimiter();
  let env = 0;
  return {
    /**
     * @param {number} hit beatHit, 0–1
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing `ctx.reduceFlashing`
     * @returns {number} 0–1
     */
    step(hit, dt, reduceFlashing) {
      env *= Math.exp(-dt * SPIKE_DECAY);
      const h = clamp(hit, 1);
      if (h > env) env = h;
      return flash.step(env, dt, reduceFlashing);
    },
  };
}

/** Corona rotation (rad/s) in silence; energy turns it up to (1 + CORONA_GAIN) × that. */
export const CORONA_RATE = 0.03;
const CORONA_GAIN = 4;
/** Easing (s) of the halo's bloom and of the sun's rise; the shafts' attack and release. */
const BLOOM_TAU = 1.5;
const RISE_TAU = 4;
const RAYS_ATTACK = 0.04;
const RAYS_RELEASE = 0.25;

/**
 * The sun's slower moods. `bloom` (0–1): a soft halo for loud passages (reactivity · energy²,
 * easing over BLOOM_TAU). `rise` (0–1): how high the sun stands, building with the song's energy
 * over RISE_TAU and sinking toward the horizon as it falls (`motion` scales it). `rays` (0–1): the
 * light shafts' pulse with `audio.bass` (1 = average), gated by energy^1.5, quick up, easy down.
 * `corona`: the corona's rotation (rad), faster with energy.
 */
export function createSunMood() {
  let rise = 0;
  const m = {
    bloom: 0,
    rise: 0,
    rays: 0,
    corona: 0,
    /**
     * @param {number} energy createEnergy's value, 0–1
     * @param {number} bass `audio.bass`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} motion 0–1
     */
    step(energy, bass, dt, reactivity, motion) {
      const r = clamp(reactivity, 2);
      const e = clamp(energy, 1);
      const mo = clamp(motion, 1);
      const drive = clamp(r * e, 1);
      m.bloom += (clamp(r * e * e, 1) - m.bloom) * (1 - Math.exp(-dt / BLOOM_TAU));
      rise += (drive - rise) * (1 - Math.exp(-dt / RISE_TAU));
      m.rise = mo * rise;
      const shafts = clamp(0.5 * r * clamp(bass, 3) * e ** 1.5, 1);
      m.rays += (shafts - m.rays) * (1 - Math.exp(-dt / (shafts > m.rays ? RAYS_ATTACK : RAYS_RELEASE)));
      m.corona += CORONA_RATE * mo * (1 + CORONA_GAIN * drive) * dt;
      return m;
    },
  };
  return m;
}

/** The ground's reflection of the range and the beam in silence (or at reactivity 0). */
export const REFLECT_REST = 0.15;

/**
 * How strongly the range and the beam shimmer in the dark ground, 0–1: REFLECT_REST plus
 * reactivity · (0.55 · energy + 0.3 · beam · √energy). Both inputs are already smooth.
 * @param {number} energy createEnergy's value, 0–1
 * @param {number} beam createBeam's level, 0–1
 * @param {number} reactivity 0–2
 */
export function reflection(energy, beam, reactivity) {
  const e = clamp(energy, 1);
  return clamp(REFLECT_REST + clamp(reactivity, 2) * (0.55 * e + 0.3 * clamp(beam, 1) * Math.sqrt(e)), 1);
}
