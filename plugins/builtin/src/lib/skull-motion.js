// @ts-check
/** Skull Trip's motion: spring-damped jaw, nod, turn and scale pulse. Nothing allocates per step. */

/** Integration substep (s): fixed, so 60 Hz and 120 Hz displays follow the same trajectory. */
const H = 1 / 480;

/**
 * A damped spring (natural frequency `freq` Hz, damping ratio `damping` < 1 overshoots). `step`
 * pulls the value toward `target`; `kick` adds velocity (an impulse).
 * @param {number} freq
 * @param {number} damping
 * @param {number} [vmax] speed limit (units/s), so even a flurry of hits can't snap it
 */
export function createSpring(freq, damping, vmax = Infinity) {
  const w = 2 * Math.PI * freq;
  const s = {
    value: 0,
    velocity: 0,
    /** Unintegrated time carried to the next step, so substeps line up at any frame rate. */
    carry: 0,
    /** @param {number} target @param {number} dt seconds */
    step(target, dt) {
      s.carry += Math.max(0, dt);
      while (s.carry >= H) {
        s.carry -= H;
        s.velocity += (w * w * (target - s.value) - 2 * damping * w * s.velocity) * H;
        if (s.velocity > vmax) s.velocity = vmax;
        else if (s.velocity < -vmax) s.velocity = -vmax;
        s.value += s.velocity * H;
      }
      return s.value;
    },
    /** @param {number} v velocity to add (units/s) */
    kick(v) {
      s.velocity += v;
    },
  };
  return s;
}

/** Widest jaw opening (radians) at Jaw 1. */
export const JAW_MAX = 0.4;
/** Hard limit on the jaw angle whatever the params (the bounding circle covers this). */
export const JAW_LIMIT = 0.6;
/** Largest nod (pitch, radians). */
export const NOD_LIMIT = 0.16;
/** Largest side-to-side head turn (yaw, radians). */
export const TURN_LIMIT = 0.3;
/** Largest tilt (roll, radians). */
export const TILT_LIMIT = 0.1;
/** Most the bass pulse scales the skull up (×(1 + PULSE_LIMIT)). */
export const PULSE_LIMIT = 0.08;
/** Velocity (rad/s) a full-strength beat gives the nod. */
const NOD_KICK = 2.2;
/** Velocity (rad/s) a full-strength beat gives the tilt. */
const TILT_KICK = 1.2;
/** Seconds for a kick's bite envelope to fall to 1/e. */
const BITE_TAU = 0.1;

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * All of the skull's motion. `step` once per frame; read the fields afterwards.
 */
export function createSkullMotion() {
  const jawSpring = createSpring(4.5, 0.45, 9);
  const nodSpring = createSpring(2.2, 0.3, 4);
  const turnSpring = createSpring(1.4, 0.8, 2.5);
  const tiltSpring = createSpring(1.8, 0.35, 3);
  const pulseSpring = createSpring(2.5, 0.7, 0.8);
  pulseSpring.value = 1;
  let side = 1;
  let bite = 0;
  let beats = 0;
  let lastPhase = 0;
  const m = {
    /** Jaw opening, radians, 0 to JAW_LIMIT. */
    jaw: 0,
    /** Nod, radians, positive = chin down. */
    pitch: 0,
    /** Head turn, radians. */
    yaw: 0,
    /** Tilt, radians. */
    roll: 0,
    /** Size multiplier, 1 to 1 + PULSE_LIMIT. */
    scale: 1,
    /**
     * @param {{ onset: boolean, onsetStrength: number, bass: number, bassAtt: number, beatPhase: number }} audio
     * @param {number} dt seconds
     * @param {{ jaw: number, reactivity: number, nod: number }} drive Jaw and Reactivity params, nod scale
     */
    step(audio, dt, drive) {
      const react = clamp(drive.reactivity, 0, 2);
      bite *= Math.exp(-dt / BITE_TAU);
      if (audio.onset) {
        // Kicks bite hardest: weight the onset by how much bass is in it.
        const bassy = clamp(((audio.bass || 0) - 0.6) / 0.9, 0.25, 1);
        bite = Math.max(bite, (0.45 + 0.55 * clamp(audio.onsetStrength || 0, 0, 1)) * bassy);
      }
      if (audio.onset) {
        // Set (don't add) the nod's velocity so a burst of onsets can't wind it up.
        const v = NOD_KICK * (0.4 + 0.6 * clamp(audio.onsetStrength || 0, 0, 1)) * react * clamp(drive.nod, 0, 1);
        if (v > nodSpring.velocity) nodSpring.velocity = v;
        // Tilt to alternate sides, beat by beat.
        side = -side;
        tiltSpring.velocity = side * TILT_KICK * (0.4 + 0.6 * clamp(audio.onsetStrength || 0, 0, 1)) * react * clamp(drive.nod, 0, 1);
      }
      m.roll = clamp(tiltSpring.step(0, dt), -TILT_LIMIT, TILT_LIMIT);
      const swell = PULSE_LIMIT * clamp(((audio.bassAtt || 0) - 1) * 0.8 * react, 0, 1);
      m.scale = clamp(pulseSpring.step(1 + swell, dt), 1 - 0.25 * PULSE_LIMIT, 1 + PULSE_LIMIT);
      m.pitch = clamp(nodSpring.step(0, dt), -NOD_LIMIT, NOD_LIMIT);
      // Sway once per two beats: count beats where beatPhase wraps, so the turn never jumps.
      const phase = clamp(audio.beatPhase || 0, 0, 1);
      if (phase < lastPhase - 0.5) beats = (beats + 1) % 2;
      lastPhase = phase;
      const sway = Math.sin(Math.PI * (beats + phase));
      m.yaw = clamp(turnSpring.step(TURN_LIMIT * sway * Math.min(1, react) * clamp(drive.nod, 0, 1), dt), -TURN_LIMIT, TURN_LIMIT);
      const open = clamp(bite * 1.6 * react + 0.12 * clamp((audio.bassAtt || 0) - 1, 0, 1) * react, 0, 1.6);
      const limit = Math.min(JAW_LIMIT, JAW_MAX * clamp(drive.jaw, 0, 2));
      m.jaw = clamp(jawSpring.step(open * JAW_MAX * clamp(drive.jaw, 0, 2), dt), 0, limit);
      return m;
    },
  };
  return m;
}

/** Manifest defaults of the number params. */
export const DEFAULTS = Object.freeze({ reactivity: 1, density: 1, warp: 1, speed: 1, jaw: 1, size: 1 });

/** What Reduce motion uses instead of the defaults (flow speed, warp) and scales motion by. */
export const REDUCED = Object.freeze({ speed: 0.35, warp: 0.6, nod: 0.3, ripple: 0.35 });

/**
 * This frame's motion drive. With Reduce motion on, params still at their defaults get calmer
 * values (slower flow, gentler warp, smaller nods and ripples); anything the user chose is kept.
 * @param {{ reactivity: number, warp: number, speed: number, jaw: number }} params
 * @param {boolean} reduceMotion
 * @param {{ speed: number, warp: number, nod: number, ripple: number, jaw: number, reactivity: number }} out
 */
export function effectiveDrive(params, reduceMotion, out) {
  const calmReact = reduceMotion && params.reactivity === DEFAULTS.reactivity;
  out.speed = reduceMotion && params.speed === DEFAULTS.speed ? REDUCED.speed : params.speed;
  out.warp = reduceMotion && params.warp === DEFAULTS.warp ? REDUCED.warp : params.warp;
  out.nod = calmReact ? REDUCED.nod : 1;
  out.ripple = calmReact ? REDUCED.ripple : 1;
  out.jaw = params.jaw;
  out.reactivity = params.reactivity;
  return out;
}
