// @ts-check
/**
 * Eclipse's pure logic (allocation-free per step): the corona's circular spectrogram, the ring's
 * bass response, beat flares, flash-limited brightness, tint/sky selection, layout and motion.
 * GPU side: shaders/eclipse/.
 */

import { createFlashLimiter } from "./flash.js";
import { createSpectroGain, logColumns, resampleSpectrum } from "./spectro.js";

/** Angular sectors in the corona level texture (one full turn). */
export const SECTORS = 256;

/** Frequency range of the corona (Hz): bottom → top. */
export const F_MIN = 30;
export const F_MAX = 16000;

/** Level smoothing time constants (s): tendrils burst out quickly and recede organically. */
export const ATTACK = 0.05;
export const RELEASE = 0.35;

/** Sectors a level spreads to on each side (falling off linearly). */
const SPREAD = 3;

/**
 * The corona's circular spectrogram. Sector i sits at angle
 *   a = ((i + 0.5) / count − 0.5) · 2π   (0 = straight down, +π/2 = right, ±π = top),
 * the shader's `atan(p.x, −p.y)`. Frequencies run on a log axis from fMin at the bottom to fMax at
 * the top, mirrored left/right. Levels are spectro.js dB levels (gate + slow per-frequency
 * auto-gain) smoothed with ATTACK / RELEASE, 0–1.
 * @param {number} [count]
 */
export function createCorona(count = SECTORS) {
  const lo = new Float32Array(count);
  const hi = new Float32Array(count);
  const mags = new Float32Array(count);
  const raw = new Float32Array(count);
  const wide = new Float32Array(count);
  const levels = new Float32Array(count);
  logColumns("mirrored", F_MIN, F_MAX, lo, hi);
  const gain = createSpectroGain(count);
  gain.setTilt(lo, hi);
  return {
    lo,
    hi,
    levels,
    /**
     * @param {ArrayLike<number>} spectrum
     * @param {number} sampleRate
     * @param {number} dt
     */
    step(spectrum, sampleRate, dt) {
      resampleSpectrum(spectrum, sampleRate, lo, hi, mags);
      gain.step(mags, dt, raw);
      // Dilate across neighbouring angles (max with a linear falloff), so a pure tone lights a
      // small wedge — a few trees — rather than a single hairline.
      for (let i = 0; i < count; i++) {
        let v = raw[i];
        for (let k = 1; k <= SPREAD; k++) {
          const f = 1 - k / (SPREAD + 1);
          const a = raw[(i + k) % count] * f;
          const b = raw[(i - k + count) % count] * f;
          if (a > v) v = a;
          if (b > v) v = b;
        }
        wide[i] = v;
      }
      const ka = 1 - Math.exp(-dt / ATTACK);
      const kr = 1 - Math.exp(-dt / RELEASE);
      for (let i = 0; i < count; i++) {
        const d = wide[i] - levels[i];
        levels[i] += d * (d > 0 ? ka : kr);
      }
    },
  };
}

/** Radius of the black disc at rest, in units of the composition radius (fitEclipse). */
export const DISC = 0.44;

/** Annulus width at rest (Ring thickness 1). */
export const RING = 0.18;
/** At full bass the disc shrinks by this fraction and the annulus widens by this fraction. */
const BASS_SHRINK = 0.06;
export const BASS_WIDEN = 0.25;
/** Bass envelope time constants (s): the sun pushes back smoothly, and relaxes slower. */
const SWELL_ATTACK = 0.12;
const SWELL_RELEASE = 0.4;

/**
 * The ring's response to the bass. `swell` (0–1) follows `bassAtt` (≈1 = average) above half
 * the average, × Reactivity, smoothed; the disc shrinks and the annulus widens with it.
 * Radii are in composition units (the fit radius = 1).
 */
export function createRing() {
  const r = {
    disc: DISC,
    outer: DISC + RING,
    /** Smoothed bass drive 0–1: ring glow, thickness, disc shrink. */
    swell: 0,
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} thickness Ring thickness param (× RING)
     */
    step(bassAtt, dt, reactivity, thickness) {
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      const x = ((bassAtt - 0.5) / 1.5) * react;
      const target = x > 0 ? (x < 1 ? x : 1) : 0; // NaN → 0
      const tau = target > r.swell ? SWELL_ATTACK : SWELL_RELEASE;
      r.swell += (target - r.swell) * (1 - Math.exp(-dt / tau));
      const th = thickness > 0 ? thickness : 0;
      r.disc = DISC * (1 - BASS_SHRINK * r.swell);
      r.outer = r.disc + RING * th * (1 + BASS_WIDEN * r.swell);
    },
  };
  return r;
}

/** Flare pool size (uniform vec2 array length in the shader). */
export const FLARES = 4;

/** Flare travel speed (composition units/s), amplitude decay (s), and where it's gone. */
const FLARE_SPEED = 0.5;
const FLARE_DECAY = 0.45;
const FLARE_END = 1;
const FLARE_MIN = 0.02;

/**
 * Beat flares: each onset launches a ring of extra brightness from the ring's outer edge that
 * travels outward through the corona and fades. `data` holds FLARES × (radius past the ring's
 * outer edge, amplitude 0–1); amplitude 0 = free slot. A new onset takes a free slot, else the
 * oldest (farthest) flare's.
 */
export function createFlares() {
  const data = new Float32Array(2 * FLARES);
  return {
    data,
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength` (≈0–1)
     * @param {number} dt seconds
     * @param {number} reactivity 0–2 (amplitude × min(1, reactivity))
     */
    step(onset, strength, dt, reactivity) {
      const fade = Math.exp(-dt / FLARE_DECAY);
      for (let i = 0; i < FLARES; i++) {
        if (data[2 * i + 1] <= 0) continue;
        data[2 * i] += FLARE_SPEED * dt;
        data[2 * i + 1] *= fade;
        if (data[2 * i + 1] < FLARE_MIN || data[2 * i] > FLARE_END) data[2 * i] = data[2 * i + 1] = 0;
      }
      if (!onset) return;
      const s = strength > 0 ? (strength < 1 ? strength : 1) : 0;
      const react = reactivity > 0 ? (reactivity < 1 ? reactivity : 1) : 0;
      const amp = (0.35 + 0.65 * s) * react;
      if (amp < FLARE_MIN) return;
      let slot = 0;
      for (let i = 0; i < FLARES; i++) {
        if (data[2 * i + 1] <= 0) {
          slot = i;
          break;
        }
        if (data[2 * i] > data[2 * slot]) slot = i;
      }
      data[2 * slot] = 0;
      data[2 * slot + 1] = amp;
    },
  };
}

/** Weight of the bass swell in the full-frame brightness (a flare counts 1). */
const SWELL_WEIGHT = 0.5;

/**
 * Photosensitivity: the frame's audio-driven extra brightness — the ring's bass swell (its glow
 * and width) plus the brightest flare plus the background's brightening — goes through the flash limiter (lib/flash.js). `scale`
 * (0–1) is what to multiply both by this frame: 1 unless the limiter is holding back a rise.
 */
export function createGlare() {
  const flash = createFlashLimiter();
  const g = {
    /** Limited extra brightness. */
    level: 0,
    scale: 1,
    /**
     * @param {number} swell ring swell 0–1
     * @param {Float32Array} flares createFlares().data
     * @param {number} dt seconds
     * @param {boolean} enabled `ctx.reduceFlashing`
     * @param {number} [extra] the background's audio-driven brightening (clouds, rim light, sky
     *   rays, the water's streak), in the same units; `scale` applies to it too
     */
    step(swell, flares, dt, enabled, extra = 0) {
      let top = 0;
      for (let i = 1; i < flares.length; i += 2) if (flares[i] > top) top = flares[i];
      const target = SWELL_WEIGHT * swell + top + (extra > 0 ? extra : 0);
      g.level = flash.step(target, dt, enabled);
      g.scale = target > 1e-6 ? Math.min(1, g.level / target) : 1;
    },
  };
  return g;
}

/** Tint names, as in the manifest's `tint` options. */
export const TINTS = ["monochrome", "silver", "sepia", "cold blue"];

// Per-channel gamma applied to the grey value: like toning a silver print, it colours the greys
// while pure black and pure white stay put. Rows follow TINTS.
// prettier-ignore
const TINT_GAMMA = new Float32Array([
  1, 1, 1,
  1.06, 1.0, 0.9,     // silver: a faint cool metallic cast
  0.82, 1.0, 1.35,    // sepia: warm browns
  1.35, 1.1, 0.8,     // cold blue
]);

/**
 * The tint's per-channel gamma (color = grey^gamma). Unknown names → monochrome.
 * @param {unknown} name
 * @param {Float32Array} out length ≥ 3
 */
export function tintGamma(name, out) {
  const i = Math.max(0, TINTS.indexOf(String(name)));
  out[0] = TINT_GAMMA[3 * i];
  out[1] = TINT_GAMMA[3 * i + 1];
  out[2] = TINT_GAMMA[3 * i + 2];
  return out;
}

/**
 * Alpha of the sky: "black" (default) paints it opaque black; "none" leaves black transparent so
 * the ring and corona float on the desktop (premultiplied, alpha = brightest channel).
 * @param {unknown} name
 */
export function skyAlpha(name) {
  return name === "none" ? 0 : 1;
}

/** Margin around the composition's unit circle, as a fraction of min(width, height). */
const MARGIN = 0.03;

/** Water options, as in the manifest's `water` param (default low). */
export const WATERS = ["off", "low", "mid"];
/** Waterline height (fraction of the canvas height) per water option. */
const WATERLINE = [0, 0.22, 0.36];
/** With water, the eclipse's centre sits this many composition radii above the waterline. */
const LIFT = 0.85;

/**
 * Layout for any aspect: the composition's unit circle (the corona's full reach) is centred and
 * fits min(width, height) with a margin; clouds spill beyond it into the corners. With water
 * ("low", "mid"; unknown → "low"), `horizon` is the waterline in px from the bottom and the
 * composition sits above it — its centre LIFT radii up, its top inside the canvas — so the ring
 * stands clear of the water; "off" → horizon 0.
 * @param {number} width drawing-buffer px
 * @param {number} height
 * @param {{ cx: number, cy: number, radius: number, horizon?: number }} out
 * @param {unknown} [water]
 */
export function fitEclipse(width, height, out, water = "off") {
  const wi = WATERS.indexOf(String(water));
  const line = WATERLINE[wi < 0 ? 1 : wi];
  out.cx = width / 2;
  if (line === 0) {
    out.cy = height / 2;
    out.radius = Math.max(1, (Math.min(width, height) / 2) * (1 - 2 * MARGIN));
    out.horizon = 0;
    return out;
  }
  const horizon = line * height;
  const m = MARGIN * Math.min(width, height);
  out.radius = Math.max(1, Math.min(width / 2 - m, (height - horizon - m) / (1 + LIFT)));
  out.cy = horizon + LIFT * out.radius;
  out.horizon = horizon;
  return out;
}

/** Manifest defaults of Rotation (rad/s) and Reactivity; Reduce motion eases only these. */
export const DEFAULT_ROTATION = 0.03;
export const DEFAULT_REACTIVITY = 1;

/**
 * Motion after `ctx.reduceMotion`: calmer defaults (a third of the rotation, 70 % reactivity)
 * while the user's own picks are respected; the cloud drift is always slower.
 * @param {number} rotation Rotation param, rad/s
 * @param {number} reactivity Reactivity param
 * @param {boolean} reduceMotion
 * @param {{ rotation: number, reactivity: number, drift: number }} out
 */
export function effectiveMotion(rotation, reactivity, reduceMotion, out) {
  out.rotation = rotation;
  out.reactivity = reactivity;
  out.drift = 1;
  if (reduceMotion) {
    if (rotation === DEFAULT_ROTATION) out.rotation = rotation / 3;
    if (reactivity === DEFAULT_REACTIVITY) out.reactivity = 0.7 * reactivity;
    out.drift = 0.4;
  }
  return out;
}

/** Waveform points along each half of the ring (bottom → top), and their smoothing (s). */
const RIPPLE_POINTS = 32;
const RIPPLE_TAU = 0.06;

/**
 * The ring's edge ripple: the waveform (any length; read `.length`) averaged into RIPPLE_POINTS
 * blocks laid from the bottom of the ring to the top on both sides (mirrored like the corona),
 * eased in time and interpolated per sector, so the edges breathe with the wave without jaggies.
 * `out` is −1..1 per sector (the shader scales it to a hairline).
 * @param {number} [count]
 */
export function createRipple(count = SECTORS) {
  const out = new Float32Array(count);
  const pts = new Float32Array(RIPPLE_POINTS);
  return {
    out,
    /** @param {ArrayLike<number>} wave `audio.waveform` @param {number} dt */
    step(wave, dt) {
      const len = wave.length;
      const k = 1 - Math.exp(-dt / RIPPLE_TAU);
      for (let j = 0; j < RIPPLE_POINTS; j++) {
        const a = Math.floor((j * len) / RIPPLE_POINTS);
        const b = Math.floor(((j + 1) * len) / RIPPLE_POINTS);
        let sum = 0;
        for (let i = a; i < b; i++) sum += wave[i];
        const m = b > a ? sum / (b - a) : 0;
        const v = m > -1 ? (m < 1 ? m : 1) : m <= -1 ? -1 : 0; // NaN → 0
        pts[j] += (v - pts[j]) * k;
      }
      for (let i = 0; i < count; i++) {
        const h = Math.abs((i + 0.5) / count - 0.5) * 2; // 0 bottom … 1 top
        const x = h * (RIPPLE_POINTS - 1);
        const j = Math.min(RIPPLE_POINTS - 2, Math.floor(x));
        out[i] = pts[j] + (pts[j + 1] - pts[j]) * (x - j);
      }
    },
  };
}

/**
 * The density at which the marbled clouds' edge is cut (shaders/eclipse): more Clouds, louder
 * mids (smoothed, 0–1) and more energy (createFlow) lower it, so the ink spreads; −0.2…0.2.
 * @param {number} clouds Clouds param, 0–1
 * @param {number} mid smoothed mids, 0–1
 * @param {number} [energy] createFlow().energy, 0–1
 */
export function cloudThreshold(clouds, mid, energy = 0) {
  const c = clouds > 0 ? (clouds < 1 ? clouds : 1) : 0; // NaN → 0
  const m = mid > 0 ? (mid < 1 ? mid : 1) : 0;
  const th = 0.2 - 0.26 * c - 0.12 * m - 0.09 * unit(energy);
  return th > -0.2 ? th : -0.2;
}

/** Clamp to 0–1 (NaN → 0). @param {number} x */
const unit = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Loudness (raw `rms`) mapped to 0–1: ~0 below RMS_FLOOR, 1 at RMS_FULL. */
const RMS_FLOOR = 0.005;
const RMS_FULL = 0.25;
/** Energy envelope (s): rises quickly with the music, settles slowly. */
const ENERGY_ATTACK = 0.25;
const ENERGY_RELEASE = 1.2;
/** Cloud orbit (rad/s): a drift in silence, ORBIT_LOUD at full energy. */
const ORBIT_IDLE = 0.012;
const ORBIT_LOUD = 0.08;
/** A beat's surge (rad/s at full strength): eased in over SURGE_RISE, fading over SURGE_DECAY. */
const ORBIT_SURGE = 0.6;
const SURGE_RISE = 0.04;
const SURGE_DECAY = 0.15;
/** The clouds' formation clock (noise-time units/s): masses form and dissolve this fast. */
const EVOLVE_IDLE = 0.03;
const EVOLVE_LOUD = 0.22;

/**
 * The clouds' orbital flow around the eclipse: `energy` (0–1) follows the raw loudness (`rms`,
 * absolute — a quiet passage stays quiet) weighted by the bass, smoothed; `speed` (rad/s) is a
 * slow drift plus energy plus a beat `surge` (0–1: each onset kicks an impulse that the surge
 * eases toward and then follows down, so it never jumps); `angle` integrates it. `evolve` is the
 * clouds' formation clock (the time axis of their noise): it runs faster with energy and beats,
 * so masses grow, dissolve and re-form faster when the music is loud.
 */
export function createFlow() {
  let kick = 0;
  let ease = 0;
  const f = {
    surge: 0,
    energy: 0,
    speed: ORBIT_IDLE,
    angle: 0,
    evolve: 0,
    /**
     * @param {number} rms `audio.rms`
     * @param {number} bassAtt `audio.bassAtt`
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     * @param {number} [drift] effectiveMotion's drift: Reduce motion slows the flow by it
     */
    step(rms, bassAtt, onset, strength, dt, reactivity, drift = 1) {
      const loud = unit((rms - RMS_FLOOR) / (RMS_FULL - RMS_FLOOR));
      const target = loud * (0.6 + 0.4 * unit(bassAtt / 1.5));
      const tau = target > f.energy ? ENERGY_ATTACK : ENERGY_RELEASE;
      f.energy += (target - f.energy) * (1 - Math.exp(-dt / tau));
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      kick *= Math.exp(-dt / SURGE_DECAY);
      if (onset) kick = unit(kick + unit(strength));
      // Two cascaded easings: an S-shaped rise, so the orbit's speed never steps.
      const ka = 1 - Math.exp(-dt / SURGE_RISE);
      ease += (kick - ease) * ka;
      f.surge += (ease - f.surge) * ka;
      // A beat's surge scales with the energy too (backgroundDrive): quiet beats barely stir it.
      const surge = f.surge * (0.1 + 0.9 * f.energy);
      f.speed = (ORBIT_IDLE + (ORBIT_LOUD * f.energy + ORBIT_SURGE * surge) * react) * drift;
      f.angle = (f.angle + f.speed * dt) % (2 * Math.PI);
      const rate = EVOLVE_IDLE + EVOLVE_LOUD * (0.8 * f.energy + surge) * react;
      f.evolve = (f.evolve + rate * drift * dt) % 1000;
    },
  };
  return f;
}

/** Sectors the cloud bias is blurred over on each side (a triangle): broad banks, not wedges. */
const BIAS_SPREAD = 16;
/** Bias gain (× level above the ring's mean) and time constants (s). */
const BIAS_GAIN = 2.5;
const BIAS_ATTACK = 0.12;
const BIAS_RELEASE = 0.5;

/**
 * The clouds' density bias by angle, echoing the corona: the corona levels (createCorona) blurred
 * broadly around the ring, minus their mean, × Reactivity — positive where the spectrum is loud
 * (the ink billows outward), negative where it's quiet (it thins). −1..1 per sector, smoothed.
 * @param {number} [count]
 */
export function createCloudBias(count = SECTORS) {
  const out = new Float32Array(count);
  const blur = new Float32Array(count);
  return {
    out,
    /**
     * @param {Float32Array} levels createCorona().levels
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(levels, dt, reactivity) {
      let mean = 0;
      const norm = BIAS_SPREAD + 1;
      for (let i = 0; i < count; i++) {
        let s = levels[i] * norm;
        for (let k = 1; k <= BIAS_SPREAD; k++) {
          const w = norm - k;
          s += (levels[(i + k) % count] + levels[(i - k + count) % count]) * w;
        }
        blur[i] = s / (norm * norm);
        mean += blur[i];
      }
      mean /= count;
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      const ka = 1 - Math.exp(-dt / BIAS_ATTACK);
      const kr = 1 - Math.exp(-dt / BIAS_RELEASE);
      for (let i = 0; i < count; i++) {
        let t = (blur[i] - mean) * BIAS_GAIN * react;
        t = t > -1 ? (t < 1 ? t : 1) : t <= -1 ? -1 : 0; // NaN → 0
        const d = t - out[i];
        out[i] += d * (Math.abs(t) > Math.abs(out[i]) ? ka : kr);
      }
    },
  };
}

/** Sky pulse pool size (uniform vec2 array length in the shaders). */
export const PULSES = 4;
/** Sky pulse speed (units/s), amplitude decay (s), and where it's gone (past the ring's edge). */
const PULSE_SPEED = 1.2;
const PULSE_DECAY = 0.7;
const PULSE_END = 2.2;

/**
 * Sky pulses: each onset sends a wave outward from the ring's outer edge across the whole sky —
 * the faint rays light up as it passes and it pushes the clouds outward (a shockwave). Like
 * createFlares but slower, longer-lived and farther-reaching. `data` holds PULSES × (distance past
 * the ring's outer edge, amplitude 0–1); amplitude 0 = free slot; a new onset takes a free slot,
 * else the farthest pulse's.
 */
export function createPulses() {
  const data = new Float32Array(2 * PULSES);
  return {
    data,
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength` (≈0–1)
     * @param {number} dt seconds
     * @param {number} reactivity 0–2 (amplitude × min(1, reactivity))
     */
    step(onset, strength, dt, reactivity) {
      const fade = Math.exp(-dt / PULSE_DECAY);
      for (let i = 0; i < PULSES; i++) {
        if (data[2 * i + 1] <= 0) continue;
        data[2 * i] += PULSE_SPEED * dt;
        data[2 * i + 1] *= fade;
        if (data[2 * i + 1] < FLARE_MIN || data[2 * i] > PULSE_END) data[2 * i] = data[2 * i + 1] = 0;
      }
      if (!onset) return;
      const st = unit(strength);
      const amp = (0.1 + 0.9 * st * st) * unit(reactivity); // beats ≫ hats
      if (amp < FLARE_MIN) return;
      let slot = 0;
      for (let i = 0; i < PULSES; i++) {
        if (data[2 * i + 1] <= 0) {
          slot = i;
          break;
        }
        if (data[2 * i] > data[2 * slot]) slot = i;
      }
      data[2 * slot] = 0;
      data[2 * slot + 1] = amp;
    },
  };
}

/** Cloud light time constants (s): bass brightening, and the beat rim pulse's rise and fall. */
const BRIGHT_ATTACK = 0.12;
const BRIGHT_RELEASE = 0.5;
const RIM_RISE = 0.05;
const RIM_DECAY = 0.3;

/**
 * The clouds' light: `bright` (0–1) follows the bass (`bassAtt` above ~0.6 of its average, gated
 * by the raw level so silence stays dark) × Reactivity, smoothed; `rim` (0–1) is the ring's rim
 * light on the clouds, which pulses on beats (an impulse the light eases toward, then fades).
 * Both are part of the glare (createGlare `extra`), so they're flash-limited with the ring.
 */
export function createCloudLight() {
  let kick = 0;
  const l = {
    bright: 0,
    rim: 0,
    /**
     * @param {number} bassAtt `audio.bassAtt`
     * @param {number} rms `audio.rms`
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(bassAtt, rms, onset, strength, dt, reactivity) {
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      const gate = unit((rms - RMS_FLOOR) / 0.05);
      const target = unit(((bassAtt - 0.6) / 1.2) * gate * react);
      const tau = target > l.bright ? BRIGHT_ATTACK : BRIGHT_RELEASE;
      l.bright += (target - l.bright) * (1 - Math.exp(-dt / tau));
      kick *= Math.exp(-dt / RIM_DECAY);
      if (onset) kick = unit(Math.max(kick, unit(strength) * unit(react)));
      l.rim += (kick - l.rim) * (1 - Math.exp(-dt / RIM_RISE));
    },
  };
  return l;
}

/** Billow pool size (uniform vec4 array length in clouds.frag). */
export const BILLOWS = 6;
/** Onset strength a beat needs to spawn a billow (hats don't). */
const BILLOW_MIN_STRENGTH = 0.5;
/** Billow drift (units/s), rise (s), life (s, exponential), and where it's gone. */
const BILLOW_SPEED = 0.18;
const BILLOW_RISE = 0.6;
const BILLOW_LIFE = 2.2;
const BILLOW_END = 1.8;

/**
 * Beat billows: a strong onset spawns a new mass of ink at the ring's outer edge, at the angle
 * where the spectrum is loudest (alternating between the mirrored sides), which swells in, drifts
 * outward and dissolves. `data` holds BILLOWS × (angle rad as in createCorona, distance past the
 * ring's outer edge, amplitude 0–1, seed 0–1); amplitude 0 = free slot; a new billow takes a free
 * slot, else the oldest's.
 */
export function createBillows() {
  const data = new Float32Array(4 * BILLOWS);
  const age = new Float32Array(BILLOWS);
  const peak = new Float32Array(BILLOWS);
  let side = 1;
  let spawned = 0;
  return {
    data,
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {Float32Array} levels createCorona().levels
     * @param {number} dt seconds
     * @param {number} reactivity 0–2 (amplitude × min(1, reactivity))
     */
    step(onset, strength, levels, dt, reactivity) {
      for (let i = 0; i < BILLOWS; i++) {
        if (peak[i] <= 0) continue;
        age[i] += dt;
        const a = age[i];
        const x = a < BILLOW_RISE ? a / BILLOW_RISE : 1;
        data[4 * i + 1] += BILLOW_SPEED * dt;
        data[4 * i + 2] = peak[i] * x * x * (3 - 2 * x) * Math.exp(-a / BILLOW_LIFE);
        if ((a > BILLOW_RISE && data[4 * i + 2] < FLARE_MIN) || data[4 * i + 1] > BILLOW_END) {
          peak[i] = age[i] = 0;
          data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = data[4 * i + 3] = 0;
        }
      }
      if (!onset || !(strength >= BILLOW_MIN_STRENGTH)) return;
      const amp = (0.35 + 0.65 * unit(strength)) * unit(reactivity);
      if (amp < FLARE_MIN) return;
      // The loudest sector on this side (sectors count/2… are the right half, angle > 0).
      const n = levels.length;
      const h = n >> 1;
      let best = h;
      let last = h; // the end of a plateau of equal maxima: spawn at its middle
      let top = -1;
      for (let i = h; i < n; i++) {
        const v = side > 0 ? levels[i] : levels[n - 1 - i];
        if (v > top) {
          top = v;
          best = last = i;
        } else if (v === top && last === i - 1) last = i;
      }
      const ang = (((best + last) / 2 + 0.5) / n - 0.5) * 2 * Math.PI * side;
      let slot = 0;
      for (let i = 0; i < BILLOWS; i++) {
        if (peak[i] <= 0) {
          slot = i;
          break;
        }
        if (age[i] > age[slot]) slot = i;
      }
      peak[slot] = amp;
      age[slot] = 0;
      data[4 * slot] = ang;
      data[4 * slot + 1] = 0;
      data[4 * slot + 2] = 0;
      data[4 * slot + 3] = (spawned++ * 0.618034) % 1;
      side = -side;
    },
  };
}

/** Water ring pool size (uniform vec4 array length in water.frag). */
export const RINGS = 4;
/** Ripple level in silence, and the waveform rms that makes the water fully choppy. */
const CHOP_IDLE = 0.06;
const CHOP_FULL = 0.2;
const CHOP_ATTACK = 0.08;
const CHOP_RELEASE = 0.3;
/** Bass swell envelope (s): long waves build up and die down slowly. */
const SWELL_UP = 0.4;
const SWELL_DOWN = 1.2;
/** Rolling-wave phase speed (wave periods/s) at rest and added at full swell. */
const ROLL_IDLE = 0.25;
const ROLL_BASS = 0.9;
/** The sun's streak on the water (its length follows the bass): rise and fall (s). */
const STREAK_UP = 0.15;
const STREAK_DOWN = 0.6;
/** Beat rings: spread speed (water-plane units/s), amplitude decay (s), and where they're gone. */
const RING_SPEED = 0.6;
const RING_DECAY = 1.0;
const RING_END = 4;

/**
 * The water's motion (shaders/eclipse/water.frag). `chop` (0–1): the waveform's level (rms of its
 * newest 512 samples) keeps small ripples running — calm in silence, choppy when loud. `swell`
 * (0–1): the bass builds long rolling waves, slowly; `roll` is their phase, advancing faster with
 * the swell. `streak` (0–1): the length of the sun's vertical streak on the water, from the bass.
 * `rings`: each onset drops a ring wave at a spot on the water (scattered round the sun's
 * reflection) that spreads and fades — RINGS × (x, z, radius, amplitude 0–1) in water-plane units
 * (z = depth, 1 at the canvas's bottom edge; x across, × z per screen height); amplitude 0 = free.
 */
export function createWater() {
  const rings = new Float32Array(4 * RINGS);
  let dropped = 0;
  const w = {
    rings,
    chop: CHOP_IDLE,
    swell: 0,
    roll: 0,
    streak: 0,
    /**
     * @param {ArrayLike<number>} wave `audio.waveform` (any length)
     * @param {number} bassAtt `audio.bassAtt`
     * @param {boolean} onset `audio.onset`
     * @param {number} strength `audio.onsetStrength`
     * @param {number} dt seconds
     * @param {number} reactivity 0–2
     */
    step(wave, bassAtt, onset, strength, dt, reactivity) {
      const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      const n = wave.length;
      const from = n > 512 ? n - 512 : 0;
      let sum = 0;
      for (let i = from; i < n; i++) sum += wave[i] * wave[i];
      const level = n > from ? Math.sqrt(sum / (n - from)) : 0;
      const target = CHOP_IDLE + (1 - CHOP_IDLE) * unit((level / CHOP_FULL) * react);
      const tau = target > w.chop ? CHOP_ATTACK : CHOP_RELEASE;
      w.chop += (target - w.chop) * (1 - Math.exp(-dt / tau));
      const bass = unit(((bassAtt - 0.5) / 1.2) * react);
      w.swell += (bass - w.swell) * (1 - Math.exp(-dt / (bass > w.swell ? SWELL_UP : SWELL_DOWN)));
      w.roll = (w.roll + (ROLL_IDLE + ROLL_BASS * w.swell) * dt) % 1000;
      w.streak += (bass - w.streak) * (1 - Math.exp(-dt / (bass > w.streak ? STREAK_UP : STREAK_DOWN)));
      const fade = Math.exp(-dt / RING_DECAY);
      for (let i = 0; i < RINGS; i++) {
        if (rings[4 * i + 3] <= 0) continue;
        rings[4 * i + 2] += RING_SPEED * dt;
        rings[4 * i + 3] *= fade;
        if (rings[4 * i + 3] < FLARE_MIN || rings[4 * i + 2] > RING_END) rings.fill(0, 4 * i, 4 * i + 4);
      }
      if (!onset) return;
      const amp = (0.3 + 0.7 * unit(strength)) * unit(react);
      if (amp < FLARE_MIN) return;
      let slot = 0;
      for (let i = 0; i < RINGS; i++) {
        if (rings[4 * i + 3] <= 0) {
          slot = i;
          break;
        }
        if (rings[4 * i + 2] > rings[4 * slot + 2]) slot = i;
      }
      const k = dropped++;
      rings[4 * slot] = 0.45 * Math.sin(2.39996 * k);
      rings[4 * slot + 1] = 1.5 + 1.5 * ((k * 0.618034) % 1);
      rings[4 * slot + 2] = 0;
      rings[4 * slot + 3] = amp;
    },
  };
  return w;
}

/**
 * The reactivity the background's responses (beat pulses, billows, rim light, bass light, water,
 * the spectrum's pull on the clouds) run at: × the energy (createFlow), so a quiet passage stays
 * calm and stark while a loud one turns turbulent; a quarter of it remains in the quiet.
 * @param {number} reactivity 0–2
 * @param {number} energy createFlow().energy, 0–1
 */
export function backgroundDrive(reactivity, energy) {
  const react = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
  return react * (0.25 + 0.75 * unit(energy));
}
