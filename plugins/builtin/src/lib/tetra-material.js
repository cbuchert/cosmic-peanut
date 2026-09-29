// @ts-check
/**
 * Tetraballs materials: which one is showing (the `material` param, or `auto` cycling on musical
 * phrases) and the crossfade between them. Pure and allocation-free per step.
 */
import { createFlashLimiter } from "./flash.js";

/** Material names, in shader index order (shaders/tetraballs/*.glsl switch on the index). */
export const MATERIALS = ["chrome", "soap", "jade", "brushed", "velvet", "glass", "water", "fire", "smoke"];
/** Volumetric materials render in a reduced-resolution pass. */
export const VOLUMETRIC = [false, false, false, false, false, false, false, true, true];
/** Crossfade length, seconds. */
export const FADE = 1;

/** Auto mode's cycle: alternates looks so neighbours contrast (mirror, film, flame, glass …). */
export const AUTO_ORDER = ["chrome", "soap", "fire", "glass", "jade", "smoke", "brushed", "water", "velvet"];
/** Auto moves on every this many 4/4 bars … */
export const PHRASE_BARS = 8;
/** … or every this many seconds while there's no tempo. */
const PHRASE_NO_TEMPO = 16;
/** A sustained change in loudness (|ln(fast / slow)| above this, for SUSTAIN s) moves on early, */
const ENERGY_JUMP = 0.6;
const SUSTAIN = 1.5;
/** but never sooner than this after the previous switch. */
const MIN_DWELL = 4;

const smooth = (/** @type {number} */ t) => t * t * (3 - 2 * t);

/**
 * `a` is the material showing, `b` the one fading in, `mix` (0–1, eased) how far the fade is.
 * When no fade is running, a === b and mix === 0.
 */
export function createSequencer() {
  let progress = 0;
  let started = false;
  let autoIdx = 0;
  let phrase = 0; // 0–1 through the current phrase
  let since = 0; // seconds since the last auto switch
  let fast = 0;
  let slow = 0;
  let sustained = 0;
  const s = {
    a: 0,
    b: 0,
    mix: 0,
    /**
     * @param {string} material the param value (`auto` or a name)
     * @param {number} dt
     * @param {number} bpm tempo, 0 when unknown
     * @param {number} energy current loudness (any consistent unit, e.g. RMS)
     */
    step(material, dt, bpm, energy) {
      const e = energy > 0 ? energy : 0;
      fast += (e - fast) * (1 - Math.exp(-dt / 0.4));
      slow += (e - slow) * (1 - Math.exp(-dt / 5));
      if (!started) {
        fast = slow = e;
      }
      let want = 0;
      if (material === "auto") {
        since += dt;
        phrase += dt / (bpm >= 40 ? (PHRASE_BARS * 4 * 60) / bpm : PHRASE_NO_TEMPO);
        const jump = Math.abs(Math.log((fast + 1e-3) / (slow + 1e-3)));
        sustained = jump > ENERGY_JUMP ? sustained + dt : 0;
        if (phrase >= 1 || (sustained >= SUSTAIN && since >= MIN_DWELL)) {
          autoIdx = (autoIdx + 1) % AUTO_ORDER.length;
          phrase = 0;
          since = 0;
          sustained = 0;
          slow = fast; // the new level is the new normal
        }
        want = MATERIALS.indexOf(AUTO_ORDER[autoIdx]);
      } else {
        want = Math.max(0, MATERIALS.indexOf(material));
      }
      if (!started) {
        started = true;
        s.a = s.b = want;
      }
      if (want !== s.b) begin(want);
      if (s.a !== s.b) {
        progress = Math.min(1, progress + dt / FADE);
        s.mix = smooth(progress);
        if (progress >= 1) {
          s.a = s.b;
          s.mix = 0;
          progress = 0;
        }
      }
    },
  };
  /** @param {number} next */
  function begin(next) {
    if (s.a !== s.b && progress >= 0.5) s.a = s.b; // mid-fade: continue from the nearer one
    s.b = next;
    progress = 0;
    s.mix = 0;
  }
  return s;
}

/** Wavelengths (nm) averaged per RGB channel: higher interference orders wash out, as in life. */
const FILM_LAMBDA = [
  [600, 640, 680],
  [510, 540, 570],
  [430, 460, 490],
];
const FILM_IOR = 1.33;

/**
 * Thin-film interference tint of a soap film (mirrors `thinFilm` in shaders/tetraballs/soap.glsl).
 * A cheap RGB stand-in for Belcour & Barla, "A Practical Extension to Microfacet Theory for the
 * Modeling of Varying Iridescence" (SIGGRAPH 2017): two-beam interference with the film's optical
 * path difference 2·n·d·cosθt and the half-wave shift at the outer face (so a vanishing film is
 * black), averaged over three wavelengths per channel in place of their spectral integration.
 * @param {number} d film thickness, nm
 * @param {number} cosI cosine of the incidence angle
 * @param {Float32Array} out rgb, 0–1 (relative reflectance; the shader scales by Fresnel)
 */
export function thinFilm(d, cosI, out) {
  const sin2 = (1 - cosI * cosI) / (FILM_IOR * FILM_IOR);
  const opd = 2 * FILM_IOR * d * Math.sqrt(Math.max(0, 1 - sin2));
  for (let c = 0; c < 3; c++) {
    const l = FILM_LAMBDA[c];
    let s = 0;
    for (let i = 0; i < 3; i++) s += 0.5 - 0.5 * Math.cos((2 * Math.PI * opd) / l[i]);
    out[c] = s / 3;
  }
  return out;
}

/**
 * Overall light level (emission of fire, environment exposure): a steady base that swells with
 * loudness plus a short pulse on onsets, through the photosensitivity limiter (lib/flash.js) so
 * with reduceFlashing at most 3 new brightenings start per second. 0.7–1.45.
 */
export function createIntensity() {
  const flash = createFlashLimiter(3);
  let level = 0;
  let pulse = 0;
  return {
    /**
     * @param {boolean} onset
     * @param {number} strength onset strength 0–1
     * @param {number} rms current loudness (waveform RMS)
     * @param {number} dt
     * @param {boolean} reduceFlashing
     */
    step(onset, strength, rms, dt, reduceFlashing) {
      level += (Math.min(1, Math.max(0, rms * 3)) - level) * (1 - Math.exp(-dt / 0.3));
      pulse *= Math.exp(-dt / 0.15);
      if (onset) pulse = Math.max(pulse, Math.min(1, Math.max(0, strength)));
      return flash.step(0.7 + 0.35 * level + 0.4 * pulse, dt, reduceFlashing);
    },
  };
}
