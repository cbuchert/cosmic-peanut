// @ts-check
/**
 * Skull Trip's op-art stripes, mirrored from shaders/skull/opart.glsl: the anti-aliased stripe,
 * the stripe drive (phase, frequency, flow, thickness) with its anti-strobe budget, the beat
 * ripples and the colours. Nothing allocates per step.
 */
import { createFlashLimiter } from "./flash.js";

/**
 * @param {number} v sin(phase), −1..1
 * @param {number} w anti-aliasing half-width in units of v (fwidth in the shader)
 * @param {number} t threshold: > 0 thins the white stripes, < 0 thickens them
 */
export function stripe(v, w, t) {
  const s = 0.5 + (v - t) / (2 * Math.max(w, 1e-6));
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/** Stripe frequency (radians of phase per unit of field) at Density 1. */
export const BASE_K = 32;
/** Largest |field value| on screen, including warp (screen units, half the short side = 1). */
export const FIELD_MAX = 2.8;
/** Largest |∂field/∂flow| per unit of Warp (checked against the mirrored field in tests). */
export const FLOW_SENS = 1.6;

/** Most stripe inversions per second any pixel may see with reduceFlashing (WCAG: 3 flashes/s). */
export const MAX_INVERSIONS = 3;
/**
 * Phase-rate budget (rad/s) at the worst pixel with reduceFlashing, split between the drive and a
 * fixed reserve for the waveform bend (WAVE_RESERVE). An inversion is π of phase; 10% headroom.
 */
export const RATE_BUDGET = 0.9 * MAX_INVERSIONS * Math.PI;
/** Part of RATE_BUDGET kept for the waveform bend (see createWaveBend). */
export const WAVE_RESERVE = 1.5;
/** How much bassAtt breathes the stripe frequency (±, at Reactivity 1). */
export const BREATHE = 0.14;
/** Seconds for the frequency to follow the bass (before any rate limit). */
const BREATHE_TAU = 0.35;
/** Flow (units/s) at Speed 1 and average energy; the warp field evolves with it. */
export const FLOW_RATE = 0.12;
/** Global phase drift (rad/s) at Speed 1: the stripes stream outward. */
export const DRIFT = 1.4;

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * The stripes' global motion: phase drift, frequency breathing with the bass, and the warp flow.
 * With reduceFlashing, the three rates are scaled down together so the fastest-changing pixel
 * (field value FIELD_MAX, flow sensitivity FLOW_SENS·warp) stays within RATE_BUDGET − WAVE_RESERVE:
 * no pixel inverts more than MAX_INVERSIONS times a second and the field can never flip at once.
 */
export function createStripeDrive() {
  const d = {
    /** Global phase (rad), subtracted from freq·field: stripes stream outward as it grows. */
    phase: 0,
    /** Stripe frequency (rad per unit of field). */
    freq: BASE_K,
    /** Warp-field clock. */
    flow: 0,
    /** Stripe threshold (thickness): see createThickness. */
    duty: 0,
    /**
     * @param {number} dt
     * @param {{ density: number, speed: number, warp: number, reactivity: number, bass: number, bassAtt: number, energy: number }} input
     * @param {boolean} reduceFlashing
     */
    step(dt, input, reduceFlashing) {
      if (!(dt > 0)) return d;
      const density = clamp(input.density, 0.25, 3);
      const speed = clamp(input.speed, 0, 3);
      const warp = clamp(input.warp, 0, 3);
      const react = clamp(input.reactivity, 0, 2);
      const energy = clamp(input.energy || 0, 0, 2);
      const target = BASE_K * density * (1 + BREATHE * react * 0.5 * clamp((input.bassAtt || 0) - 1, -1, 1));
      let dk = (target - d.freq) * (1 - Math.exp(-dt / BREATHE_TAU));
      let dphase = DRIFT * speed * (0.6 + 0.4 * energy) * dt;
      let dflow = FLOW_RATE * speed * (0.5 + 0.5 * energy) * dt;
      if (reduceFlashing) {
        const worst = Math.abs(dk) * FIELD_MAX + dphase + (d.freq + Math.abs(dk)) * FLOW_SENS * warp * dflow;
        const allowed = (RATE_BUDGET - WAVE_RESERVE) * dt;
        if (worst > allowed) {
          const s = allowed / worst;
          dk *= s;
          dphase *= s;
          dflow *= s;
        }
      }
      d.freq += dk;
      d.phase += dphase;
      d.flow += dflow;
      return d;
    },
  };
  return d;
}

/** Largest stripe threshold: white covers acos(±DUTY_MAX)/π of each period (≈ 42–58%). */
export const DUTY_MAX = 0.25;

/**
 * Stripe thickness from bass hits: the black bands fatten on a hit and relax (a whole-field
 * brightness change, so it goes through the shared flash limiter: with reduceFlashing at most
 * 3 new swells a second).
 */
export function createThickness() {
  const flash = createFlashLimiter();
  let env = 0;
  return {
    /**
     * @param {number} bass `audio.bass` (1 = average)
     * @param {number} reactivity Reactivity param
     * @param {number} dt seconds
     * @param {boolean} reduceFlashing
     * @returns {number} threshold for stripe(), 0 to DUTY_MAX
     */
    step(bass, reactivity, dt, reduceFlashing) {
      env *= Math.exp(-dt / 0.15);
      env = Math.max(env, clamp(((bass || 0) - 1) * 0.5 * clamp(reactivity, 0, 2), 0, 1));
      return DUTY_MAX * clamp(flash.step(env, dt, reduceFlashing), 0, 1);
    },
  };
}

/** Ripple ring speed (screen units/s, half the short side = 1). */
export const RIPPLE_SPEED = 0.9;

/** Seconds for a ripple's amplitude to fall to 1/e. */
export const RIPPLE_TAU = 0.7;
/** A ripple ends past this radius (off any screen) or below 1% amplitude. */
const RIPPLE_END_R = 3.2;

/**
 * Beat ripples: a preallocated ring of `cap` rings expanding from the skull. `data` holds
 * (radius, amplitude) per ring, ready for a vec2 uniform array; ended rings have amplitude 0.
 * @param {number} cap
 */
export function createRipples(cap) {
  const age = new Float32Array(cap).fill(Infinity);
  const strength = new Float32Array(cap);
  let next = 0;
  const r = {
    data: new Float32Array(cap * 2),
    /** @param {number} s amplitude, 0–1 */
    spawn(s) {
      age[next] = 0;
      strength[next] = s;
      r.data[2 * next] = 0;
      r.data[2 * next + 1] = s;
      next = (next + 1) % cap;
    },
    /** @param {number} dt */
    step(dt) {
      for (let i = 0; i < cap; i++) {
        age[i] += dt;
        const radius = age[i] * RIPPLE_SPEED;
        const amp = strength[i] * Math.exp(-age[i] / RIPPLE_TAU);
        const alive = radius < RIPPLE_END_R && amp > 0.01 * strength[i];
        r.data[2 * i] = alive ? radius : 0;
        r.data[2 * i + 1] = alive ? amp : 0;
      }
    },
  };
  return r;
}

/**
 * Decides when a beat launches a ripple. Each onset raises an envelope (sized by its strength and
 * `gain`) that goes through the shared flash limiter; a ripple launches only where the limited
 * envelope starts a new rise, so with reduceFlashing at most 3 ripples start per second.
 */
export function createRippleTrigger() {
  const flash = createFlashLimiter();
  let env = 0;
  let prev = 0;
  return {
    /**
     * @param {boolean} onset `audio.onset`
     * @param {number} onsetStrength `audio.onsetStrength`
     * @param {number} gain Reactivity × motion scale, 0–2
     * @param {number} dt
     * @param {boolean} reduceFlashing
     * @returns {number} strength of the ripple to launch now, 0 for none
     */
    step(onset, onsetStrength, gain, dt, reduceFlashing) {
      env *= Math.exp(-dt / 0.08);
      if (onset) env = clamp((0.5 + 0.5 * clamp(onsetStrength || 0, 0, 1)) * clamp(gain, 0, 2) * 0.5, 0, 1);
      const v = flash.step(env, dt, reduceFlashing);
      const launch = onset && v > prev + 1e-6 ? v : 0;
      prev = v;
      return launch;
    },
  };
}

/** Waveform bend: most phase (rad) it shifts a stripe by, and how fast (units/s) it may change. */
export const WAVE_PHASE = 1;
export const WAVE_SLEW = 1.5;

/**
 * The waveform, block-averaged into `n` points and slew-limited, for bending the stripes around
 * the skull (the shader mirrors it left/right). Slew limiting keeps a noisy waveform from making
 * the stripes jitter: with WAVE_PHASE × WAVE_SLEW ≤ WAVE_RESERVE it stays inside the anti-strobe
 * budget. Reads `waveform.length`, so any length works.
 * @param {number} n
 */
export function createWaveBend(n) {
  const out = new Float32Array(n);
  return {
    /**
     * @param {Float32Array} waveform `audio.waveform`, −1..1
     * @param {number} dt
     * @returns {Float32Array} n values in −1..1 (the same array every call)
     */
    step(waveform, dt) {
      const len = waveform.length;
      const maxStep = WAVE_SLEW * Math.max(0, dt);
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i * len) / n);
        const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
        let sum = 0;
        for (let j = a; j < b && j < len; j++) {
          const x = waveform[j];
          if (x > -2 && x < 2) sum += x; // skips NaN and wild values
        }
        const target = clamp((len ? sum / (b - a) : 0) * 1.5, -1, 1);
        out[i] += clamp(target - out[i], -maxStep, maxStep);
      }
      return out;
    },
  };
}

/** Mode and Stripes select options (manifest order; the first is the default). */
export const MODES = Object.freeze(["monochrome", "acid"]);
export const STRIPES = Object.freeze(["black & white", "black only"]);

/**
 * The look from the Mode and Stripes params: acid tints, and whether the white stripes are paper
 * (alpha 1) or transparent (alpha 0, "black only": the skull and black stripes float on the
 * desktop). Unknown values fall back to the defaults.
 * @param {unknown} mode
 * @param {unknown} stripes
 * @param {{ acid: boolean, paperAlpha: number }} out
 */
export function resolveLook(mode, stripes, out) {
  out.acid = mode === "acid";
  out.paperAlpha = stripes === "black only" ? 0 : 1;
  return out;
}

/** Seconds for the acid tints to go once round the hue circle. */
export const ACID_PERIOD = 30;

/**
 * Ink (out[0..2]) and paper (out[3..5]) colours. Monochrome is pure black on white; acid tints
 * both with slowly rotating hues (the paper a third of the way round from the ink), keeping the
 * ink dark and the paper light so the op-art stays bold.
 * @param {boolean} acid
 * @param {number} clock seconds
 * @param {Float32Array} out length ≥ 6
 */
export function lookColors(acid, clock, out) {
  if (!acid) {
    out[0] = out[1] = out[2] = 0;
    out[3] = out[4] = out[5] = 1;
    return out;
  }
  const h = clock / ACID_PERIOD;
  for (let i = 0; i < 3; i++) {
    const ink = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + i / 3));
    const paper = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.4 + i / 3));
    out[i] = 0.18 * ink;
    out[3 + i] = 0.6 + 0.4 * paper;
  }
  return out;
}

const fract = (/** @type {number} */ x) => x - Math.floor(x);

/** opart.glsl hash12 (values differ slightly from the GPU's floats; only the bounds matter). */
function hash12(/** @type {number} */ x, /** @type {number} */ y) {
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fract((a + b) * c);
}

function vnoise(/** @type {number} */ x, /** @type {number} */ y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy) + (hash12(ix + 1, iy) - hash12(ix, iy)) * ux;
  const b = hash12(ix, iy + 1) + (hash12(ix + 1, iy + 1) - hash12(ix, iy + 1)) * ux;
  return a + (b - a) * uy;
}

function fbm(/** @type {number} */ x, /** @type {number} */ y) {
  let s = 0.5 * vnoise(x, y);
  x = x * 2.03 + 1.7;
  y = y * 2.03 + 9.2;
  s += 0.25 * vnoise(x, y);
  x = x * 2.03 + 1.7;
  y = y * 2.03 + 9.2;
  s += 0.125 * vnoise(x, y);
  return s / 0.875;
}

function sdEllipse2(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ rx, /** @type {number} */ ry) {
  const k0 = Math.hypot(x / rx, y / ry);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry));
  return (k0 * (k0 - 1)) / Math.max(k1, 1e-4);
}

function smin(/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

/**
 * The stripe field of shaders/skull/opart.glsl opField, in JS, for tests of its bounds (FIELD_MAX
 * and FLOW_SENS, which the anti-strobe budget relies on). Keep the two in step.
 * @param {number} x screen units, skull at the origin
 * @param {number} y
 * @param {number} flow warp clock
 * @param {number} warp
 * @param {number[]} outline [screen units per object unit, tilt, jaw drop] (u_outline)
 */
export function opField(x, y, flow, warp, outline) {
  const ox = fbm(x * 0.8, y * 0.8 + 0.5 * flow);
  const oy = fbm(x * 0.8 + 5.2 - 0.4 * flow, y * 0.8 + 1.3);
  let qx = x + warp * 0.42 * (ox * 2 - 1);
  let qy = y + warp * 0.42 * (oy * 2 - 1);
  const r = Math.hypot(qx, qy);
  const a = warp * 1.3 * Math.exp(-0.8 * r) * Math.sin(0.6 * flow + 1);
  const c = Math.cos(a);
  const s = Math.sin(a);
  [qx, qy] = [c * qx - s * qy, s * qx + c * qy];
  // outline(q)
  const [k, tilt, drop] = outline;
  const ct = Math.cos(-tilt);
  const st = Math.sin(-tilt);
  const px = (ct * qx - st * qy) / k;
  const py = (st * qx + ct * qy) / k;
  const cranium = sdEllipse2(px, py - 0.2, 0.95, 1.0);
  const jaw = sdEllipse2(px, py + 0.72 + drop, 0.52, 0.34);
  const line = smin(cranium, jaw, 0.3) * k;
  return line + 0.25 * warp * (fbm(qx * 1.6 - 0.3 * flow, qy * 1.6) - 0.5);
}
