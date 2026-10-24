// @ts-check
/**
 * Poincaré Disk in 3D: the motion of the coin and the camera inside the tiled sphere, driven by
 * the music (shaders/tess/disk3d.frag draws it; src/poincare-disk.js wires it up). Everything
 * here eases — first-order lags and critically damped springs, smoothstep envelopes — so nothing
 * clicks, and nothing allocates per frame.
 *
 *   createWaveRim    the coin's edge: the live waveform round the circumference (triggered,
 *                    auto-gained, tapered to close without a seam), as Cosmic Peanut's ring does
 *   createCoinMotion mids spin the coin about its axis; bass tilts it and the tilt precesses
 *                    like a spinning plate
 *   createCounterSpin the sphere turns the other way to the coin, scaled by the Spin param
 *   createKicks      each beat lurches the tiling along a new direction (an eased hyperbolic
 *                    translation, then a glide) and drops a ripple at an impact point
 *   rippleLift / specLift  the per-tile lift the shader mirrors: the impact ripple, and the
 *                    spectrum heaving the tiles ring by ring outwards in hyperbolic distance
 *   createDirector   the camera: orbits, swoops, skims and pull-backs, chosen on phrase changes,
 *                    eased across, kept clear of the coin and inside the sphere; drag takes over
 *
 * Scene units: the printed face is the unit disk (radius COIN.face), the coin's face normal is
 * world +y at rest, and the sphere (radius SPHERE_R) is centred on the coin.
 */
import { createDrag } from "./sphere-view.js";

export const SCENES = ["flat", "sphere"];
export const CAMERAS = ["auto", "still"];
export const MOVES = ["orbit", "swoop", "skim", "pullback"];

/** The coin: printed face radius, bevel width, half-thickness, waveform amplitude per unit of
 * Reactivity (the rim is displaced by at most 2× this), and the most it tilts (rad). */
export const COIN = { face: 1, bevel: 0.15, half: 0.05, waveAmp: 0.07, maxTilt: 0.3 };
/** The tiled sphere's radius. */
export const SPHERE_R = 9;
/** The camera keeps this far from the coin, and this far inside the sphere. */
export const CLEAR = 0.2;
export const WALL_MARGIN = 1;

/** The beat envelope's rise (s) and fall (beats), as lib/tess-music.js's. */
const RISE = 0.08;
const FALL = 0.9;
/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** First-order lag factor for a step of dt with time constant tau. */
const lag = (/** @type {number} */ dt, /** @type {number} */ tau) => 1 - Math.exp(-dt / tau);

// ---- Waveform rim ----------------------------------------------------------------------------

/** Points round the rim (disk3d.frag u_rim). */
export const RIM_POINTS = 128;
/** Samples the rim spans (of the 2048 in a frame). */
const RIM_WINDOW = 1024;
/** Auto-gain: per-build decay of the tracked peak, and its floor. */
const PEAK_DECAY = 0.992;
const PEAK_FLOOR = 0.02;
/** Fraction at each end eased to zero (raised cosine) so the ring closes without a seam. */
const TAPER = 0.08;
/** The rim follows the waveform through this lag (s): live, but never a click. */
const RIM_TAU = 0.04;

/**
 * The waveform round the coin's edge, Cosmic Peanut style (the pattern is copied; packs are
 * served separately): an oscilloscope trigger on the first rising zero crossing (sub-sample, so
 * a steady tone stands still), resampled to RIM_POINTS, auto-gained to about ±1, tapered at both
 * ends so the circle closes, times Reactivity, eased in time. `ring` is the same array always.
 * @param {number} [M]
 */
export function createWaveRim(M = RIM_POINTS) {
  const ring = new Float32Array(M);
  const target = new Float32Array(M);
  let track = 0.1;
  return {
    ring,
    /** @param {ArrayLike<number>} wave @param {number} dt @param {number} reactivity 0–2 */
    build(wave, dt, reactivity) {
      const W = Math.min(RIM_WINDOW, wave.length - 1);
      let start = 0;
      for (let i = 1; i < wave.length - W; i++) {
        if (wave[i - 1] < 0 && wave[i] >= 0) {
          const a = wave[i - 1];
          start = i - 1 + a / (a - wave[i]);
          break;
        }
      }
      const last = wave.length - 1;
      let peak = 0;
      for (let j = 0; j < M; j++) {
        const x = start + (j * W) / M;
        const i0 = Math.floor(x);
        const i1 = i0 < last ? i0 + 1 : last;
        const f = x - i0;
        const s = (wave[i0] ?? 0) * (1 - f) + (wave[i1] ?? 0) * f;
        target[j] = s;
        peak = Math.max(peak, Math.abs(s));
      }
      track = Math.max(peak, track * PEAK_DECAY);
      const norm = 1 / Math.max(track, PEAK_FLOOR);
      const react = clamp(reactivity, 0, 2);
      const T = Math.floor(M * TAPER);
      const k = lag(dt, RIM_TAU);
      for (let j = 0; j < M; j++) {
        let w = 1;
        if (j < T) w = 0.5 - 0.5 * Math.cos((Math.PI * j) / T);
        else if (j > M - 1 - T) w = 0.5 - 0.5 * Math.cos((Math.PI * (M - 1 - j)) / T);
        const v = react * clamp(target[j] * norm, -1, 1) * w;
        ring[j] = react === 0 ? 0 : ring[j] + (v - ring[j]) * k;
      }
      return ring;
    },
  };
}

// ---- The music drive -----------------------------------------------------------------------------

/** The drive at rest in silence, and with music at average bass and between beats. */
export const SILENT_LEVEL = 0.25;
export const MUSIC_LEVEL = 0.6;
/** Seconds to ease between silence and music (a smoothstep). */
const PRESENCE_FADE = 1.5;
/** Drive per unit of bass above its average (lagged), and at the peak of a beat surge. */
const DRIVE_BASS = 1.2;
const DRIVE_SURGE = 3;
/** Bass is read as the passage's energy (slow), so the beat's own push is the surge alone. */
const DRIVE_BASS_TAU = 0.8;
/** The surge follows the beat envelope through two lags (s): an eased rise, no corner. */
const DRIVE_SURGE_TAU = 0.035;
/** Reduce motion: this much of the surge. */
const CALM_SURGE = 0.2;

/**
 * @typedef {object} DriveInput
 * @property {boolean} live music is playing (not audio.silent)
 * @property {number} bassAtt audio's (1 = average) @property {number} env the beat envelope
 * @property {number} reactivity 0–2 @property {boolean} reduceMotion
 */

/**
 * What paces the scene: the camera's path, the coin's spin (and so the wall's counter-spin) and
 * the tiling's drift all run at `level`. In silence it settles to SILENT_LEVEL, a calm drift; with
 * music it is MUSIC_LEVEL at average bass, more with the passage's bass, and each beat surges it
 * (an eased rise through two lags, gone before the next beat). `surge` (0–1) is the eased beat, for the move's intensity.
 */
export function createDrive() {
  let fade = 0;
  let bass = 0;
  let s1 = 0;
  const d = {
    level: SILENT_LEVEL,
    /** 0–1: how far into music from silence (smoothstep over PRESENCE_FADE s). */
    presence: 0,
    surge: 0,
    /** Bass above its average, lagged (−0.5…1; 0 in silence). */
    bass: 0,
    /** @param {number} dt @param {DriveInput} o */
    step(dt, o) {
      fade = clamp(fade + (o.live ? dt : -dt) / PRESENCE_FADE, 0, 1);
      d.presence = smooth(fade);
      const b = o.live ? clamp(o.bassAtt - 1, -0.5, 1) : 0;
      bass += (b - bass) * lag(dt, DRIVE_BASS_TAU);
      d.bass = bass;
      const g = lag(dt, DRIVE_SURGE_TAU);
      s1 += ((o.live ? clamp(o.env, 0, 1) : 0) - s1) * g;
      d.surge += (s1 - d.surge) * g;
      const react = clamp(o.reactivity, 0, 2);
      const music = DRIVE_BASS * bass + DRIVE_SURGE * d.surge * (o.reduceMotion ? CALM_SURGE : 1);
      d.level = Math.max(0, SILENT_LEVEL + d.presence * (MUSIC_LEVEL - SILENT_LEVEL + react * music));
      return d;
    },
  };
  return d;
}

// ---- The coin's spin and tilt ----------------------------------------------------------------

/** Spin about the coin's axis (rad/s) at rest, and how much the mids add (per unit of midAtt − 1). */
const SPIN_BASE = 0.25;
const MID_GAIN = 2;
const SPIN_TAU = 0.6;
/** Tilt (rad) per unit of bass above 0.9, and per beat surge; the spring's rate (1/s). */
const TILT_GAIN = 0.35;
const SURGE_TILT = 0.14;
const TILT_RATE = 9;
/** The tilt precesses (rad/s) at this rate, faster with bass. */
const WOBBLE = 1;

/**
 * @typedef {object} CoinInput
 * @property {number} midAtt @property {number} bassAtt audio's (1 = average)
 * @property {number} env the beat envelope (tess state `env`)
 * @property {number} reactivity 0–2 @property {boolean} reduceMotion
 * @property {number} [pace] createDrive's level (1 when omitted): spin and wobble run at it
 */

/** The coin's spin (mids) and its spinning-plate tilt (bass, beat surge). */
export function createCoinMotion() {
  let vt = 0; // tilt magnitude's speed
  let phi = 0.7;
  const c = {
    /** Angle about the coin's axis (rad) and its rate (rad/s). */
    spin: 0,
    spinRate: SPIN_BASE,
    /** Tilt angle (rad) and its components towards world x and z; the face normal. */
    tilt: 0,
    tiltX: 0,
    tiltZ: 0,
    normal: new Float64Array([0, 1, 0]),
    /** @param {number} dt @param {CoinInput} o */
    step(dt, o) {
      const react = clamp(o.reactivity, 0, 2);
      const calm = o.reduceMotion ? 0.3 : 1;
      const mids = clamp(o.midAtt - 1, -0.5, 1);
      const pace = Math.max(0, o.pace ?? 1);
      const rate = SPIN_BASE * pace * (1 + react * MID_GAIN * mids) * calm;
      c.spinRate += (rate - c.spinRate) * lag(dt, SPIN_TAU);
      c.spin += c.spinRate * dt;
      const bass = clamp(o.bassAtt - 0.9, 0, 1);
      const want = Math.min(COIN.maxTilt * (o.reduceMotion ? 0.4 : 1), react * (TILT_GAIN * bass + SURGE_TILT * clamp(o.env, 0, 1)) * calm);
      // Critically damped spring towards the wanted tilt (exact step).
      const w = TILT_RATE;
      const e = Math.exp(-w * dt);
      const x0 = c.tilt - want;
      const b = vt + w * x0;
      c.tilt = Math.min(COIN.maxTilt, Math.max(0, want + (x0 + b * dt) * e));
      vt = (vt - w * b * dt) * e;
      phi += dt * WOBBLE * pace * (1 + bass) * calm;
      c.tiltX = c.tilt * Math.cos(phi);
      c.tiltZ = c.tilt * Math.sin(phi);
      const st = Math.sin(c.tilt);
      c.normal[0] = st * Math.cos(phi);
      c.normal[1] = Math.cos(c.tilt);
      c.normal[2] = st * Math.sin(phi);
      return c;
    },
  };
  return c;
}

/** The sphere turns at this fraction of the coin's rate, the other way, per unit of Spin. */
const COUNTER = 0.6;
const COUNTER_TAU = 0.8;

/** The tiled sphere's counter-spin about the vertical: opposite to the coin's, eased. */
export function createCounterSpin() {
  const s = {
    angle: 0,
    rate: 0,
    /** @param {number} dt @param {number} coinRate rad/s @param {number} spin the Spin param (0–2) */
    step(dt, coinRate, spin) {
      const want = -clamp(spin, 0, 2) * COUNTER * coinRate;
      s.rate += (want - s.rate) * lag(dt, COUNTER_TAU);
      s.angle += s.rate * dt;
      return s;
    },
  };
  return s;
}

// ---- Beat kicks, the impact ripple, the spectrum heave -----------------------------------------

/** Hyperbolic distance per second of the kick at the envelope's peak, at Reactivity 1. */
const KICK = 2.4;
/** The kick's direction swings round to the new one through this lag (s). */
const KICK_TURN = 0.1;
/** Impact points fall within this radius of the face (screen disk units). */
const IMPACT_R = 0.7;
/** The ripple travels out at this speed (hyperbolic units/s) and fades with distance e^(−d/REACH). */
export const RIPPLE_SPEED = 3;
export const RIPPLE_REACH = 1.1;

/**
 * The ripple's lift (0–1) of a tile at hyperbolic distance d from the impact, `age` s after the
 * beat (disk3d.frag rippleLift): the beat envelope's shape (an 80 ms smoothstep rise, gone by 0.9
 * beat), arriving d / RIPPLE_SPEED later, fading with distance (over `reach`; the carved kites'
 * reach further, lib/disk-relief.js KITE_REACH).
 * @param {number} age @param {number} d @param {number} period beat length (s) @param {number} [reach]
 */
export function rippleLift(age, d, period, reach = RIPPLE_REACH) {
  const a = age - d / RIPPLE_SPEED;
  if (a <= 0) return 0;
  const fall = Math.max(0.05, FALL * period - RISE);
  const env = a < RISE ? smooth(a / RISE) : 1 - smooth((a - RISE) / fall);
  return env * Math.exp(-d / reach);
}

/**
 * The spectrum's heave of a tile at hyperbolic distance d from the face's centre (disk3d.frag
 * specLift): 16 rings out to ringR, low bands at the centre, high at the rim, interpolated.
 * @param {ArrayLike<number>} bands 16 @param {number} d @param {number} ringR
 */
export function specLift(bands, d, ringR) {
  const x = clamp(d / ringR, 0, 1) * 15;
  const i = Math.min(14, Math.floor(x));
  const f = x - i;
  return bands[i] * (1 - f) + bands[i + 1] * f;
}

/**
 * Beat kicks: each beat (the envelope starting to rise) picks a new direction and impact point;
 * the tiling then lurches along the direction at a speed following the envelope — an eased push,
 * then a glide out — and the impact's ripple spreads from where the beat landed.
 */
export function createKicks() {
  let prev = 0;
  let rising = false;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let heading = 0.3;
  const k = {
    /** Current kick direction (unit, screen disk) and the latest impact point (screen disk). */
    dir: new Float64Array([1, 0]),
    impact: new Float64Array(2),
    /** Seconds since the latest beat, and beats so far. */
    age: 99,
    count: 0,
    /**
     * @param {number} dt @param {{ env: number, reactivity: number, period: number }} o
     * @returns {number} hyperbolic distance to move this frame along `dir`
     */
    step(dt, o) {
      k.age += dt;
      const up = o.env > prev + 1e-6;
      if (up && !rising) {
        k.count++;
        k.age = 0;
        heading += 2.39996 + (rnd() - 0.5) * 1.2; // golden angle, jittered
        const r = IMPACT_R * Math.sqrt(rnd());
        const a = rnd() * 2 * Math.PI;
        k.impact[0] = r * Math.cos(a);
        k.impact[1] = r * Math.sin(a);
      }
      rising = up;
      prev = o.env;
      const g = lag(dt, KICK_TURN);
      k.dir[0] += (Math.cos(heading) - k.dir[0]) * g;
      k.dir[1] += (Math.sin(heading) - k.dir[1]) * g;
      const l = Math.hypot(k.dir[0], k.dir[1]) || 1;
      k.dir[0] /= l;
      k.dir[1] /= l;
      return KICK * clamp(o.reactivity, 0, 2) * clamp(o.env, 0, 1) * dt;
    },
  };
  return k;
}

// ---- Camera ------------------------------------------------------------------------------------

/**
 * Signed distance from p to the coin as a flat cylinder of radius rc and half-thickness
 * COIN.half about the unit normal n (centred at the origin).
 * @param {ArrayLike<number>} p @param {ArrayLike<number>} n @param {number} rc
 */
export function coinDistance(p, n, rc) {
  const ax = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const rx = p[0] - ax * n[0];
  const ry = p[1] - ax * n[1];
  const rz = p[2] - ax * n[2];
  const dx = Math.hypot(rx, ry, rz) - rc;
  const dy = Math.abs(ax) - COIN.half;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/** The coin's widest extent: face, bevel and the waveform at Reactivity 2. */
const COIN_R = COIN.face + COIN.bevel + 2 * COIN.waveAmp;
/** Path units per second at glide speed 1; Reduce motion's factor. */
const PATH_RATE = 0.35;
const CALM = 0.3;
/** A move changes on a phrase change: every PHRASE bar steps, at least MIN_DWELL s apart. */
export const PHRASE = 8;
export const MIN_DWELL = 10;
/** Seconds to ease from one move into the next (Reduce motion: twice that). */
export const TRANSIT = 5;
const ELEV_LIMIT = 1.35;
/** The moves' swing follows the music's intensity through this lag (s). */
const SWING_TAU = 0.12;

/**
 * A move's eye and look-at point at path parameter u (world; the coin at the origin). k is the
 * music's intensity (0 calm, about 1 on a beat or with heavy bass): it widens each move's swing
 * and leans the eye in.
 * @param {number} move index into MOVES @param {number} u @param {number} k
 * @param {Float64Array} eye @param {Float64Array} at
 */
function path(move, u, k, eye, at) {
  if (move === 0) {
    // Orbit: round the coin, looking down on the face, bobbing with the music.
    const az = u;
    const el = 0.5 + (0.03 + 0.16 * k) * Math.sin(2.3 * u);
    const r = 3.4 * (1 - 0.06 * k);
    eye[0] = r * Math.cos(el) * Math.cos(az);
    eye[1] = r * Math.sin(el);
    eye[2] = r * Math.cos(el) * Math.sin(az);
    at[0] = 0;
    at[1] = -0.1;
    at[2] = 0;
  } else if (move === 1) {
    // Swoop: in and over the face, rising and falling, looking across it.
    const az = 0.8 * u;
    const r = 2.2 + 0.6 * Math.sin(0.5 * u) - 0.15 * k;
    eye[0] = r * Math.cos(az);
    eye[1] = 0.55 + (0.15 + 0.3 * k) * (1 + Math.sin(1.3 * u));
    eye[2] = r * Math.sin(az);
    at[0] = 0.2 * Math.cos(az + 2);
    at[1] = 0;
    at[2] = 0.2 * Math.sin(az + 2);
  } else if (move === 2) {
    // Skim: a low pass in over the rim, looking across the face to its far side (the face fills
    // the lower part of the frame, the far rim and the wall above it), turning slowly round.
    const az = 0.35 * u;
    eye[0] = 0.95 * Math.cos(az);
    eye[1] = 0.42 + (0.02 + 0.12 * k) * Math.sin(1.9 * u);
    eye[2] = 0.95 * Math.sin(az);
    at[0] = 0.55 * Math.cos(az + 2.6);
    at[1] = -0.12;
    at[2] = 0.55 * Math.sin(az + 2.6);
  } else {
    // Pull back: the coin small against the tiled wall.
    const az = 0.25 * u + 1;
    const el = 0.3 + (0.03 + 0.11 * k) * Math.sin(1.7 * u);
    const r = 6.6 * (1 - 0.035 * k);
    eye[0] = r * Math.cos(el) * Math.cos(az);
    eye[1] = r * Math.sin(el);
    eye[2] = r * Math.cos(el) * Math.sin(az);
    at[0] = 0;
    at[1] = 0;
    at[2] = 0;
  }
}

/**
 * @typedef {object} DirectorInput
 * @property {boolean} stepped the tess state's bar step
 * @property {number} speed the pace (createDrive's level: calm in silence, bass and the beat surge)
 * @property {number} [intensity] how wide the moves swing (bass and the eased beat; 0 calm)
 * @property {boolean} reduceMotion
 * @property {string} camera "auto" | "still"
 * @property {ArrayLike<number>} normal the coin's face normal now
 */

/**
 * The camera inside the sphere. In auto it follows one of MOVES along its path at the glide's
 * speed, and on a phrase change (every PHRASE bars, at least MIN_DWELL s on) eases over TRANSIT s
 * into another. A drag orbits it (yaw, pitch) and springs back on release. Every frame the eye is
 * pushed out to CLEAR from the coin (as tilted now, at its widest rim) and kept WALL_MARGIN
 * inside the sphere. Reduce motion: slower, only orbits and pull-backs, longer eases.
 */
export function createDirector() {
  const drag = createDrag();
  const ea = new Float64Array(3);
  const ta = new Float64Array(3);
  const eb = new Float64Array(3);
  const tb = new Float64Array(3);
  let from = 0;
  let to = 0;
  let blend = 1;
  let u = 0;
  let dwell = 0;
  let steps = 0;
  let seed = 3;
  let k = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  /** @param {Float64Array} p @param {number} yaw @param {number} pitch */
  const orbitBy = (p, yaw, pitch) => {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < 1e-9) return;
    const el = clamp(Math.asin(clamp(p[1] / r, -1, 1)) + pitch, -ELEV_LIMIT, ELEV_LIMIT);
    const az = Math.atan2(p[2], p[0]) + yaw;
    p[0] = r * Math.cos(el) * Math.cos(az);
    p[1] = r * Math.sin(el);
    p[2] = r * Math.cos(el) * Math.sin(az);
  };
  /** @param {number} m */
  const startMove = (m) => {
    from = to;
    to = m;
    blend = 0;
    dwell = 0;
  };
  const d = {
    eye: new Float64Array(3),
    target: new Float64Array(3),
    /** The move under way (the one being eased into). */
    move: MOVES[0],
    /** Vertical field of view (rad). */
    fov: 0.9,
    /** Jump straight to a move, no ease (tests, stills). @param {number} m index into MOVES */
    force(m) {
      from = to = m;
      blend = 1;
      d.move = MOVES[m];
    },
    /** @param {import('../../tidalviz').PointerInput} e */
    pointer(e) {
      drag.pointer(e);
    },
    /** @param {number} dt @param {DirectorInput} o */
    step(dt, o) {
      const calm = o.reduceMotion;
      drag.step(dt, calm);
      if (o.camera === "still") {
        path(0, 0.9, 0, eb, tb);
        eb[1] *= 1.25;
        d.eye.set(eb);
        d.target.set(tb);
      } else {
        u += dt * Math.max(0, o.speed) * PATH_RATE * (calm ? CALM : 1);
        dwell += dt;
        if (o.stepped && ++steps % PHRASE === 0 && dwell >= MIN_DWELL) {
          const allowed = calm ? [0, 3] : [0, 1, 2, 3];
          const choices = allowed.filter((m) => m !== to);
          startMove(choices[Math.floor(rnd() * choices.length)]);
        }
        // Reduce motion turned on mid-skim or mid-swoop: ease out to an orbit.
        if (calm && to !== 0 && to !== 3) startMove(0);
        blend = Math.min(1, blend + dt / (TRANSIT * (calm ? 2 : 1)));
        const w = smooth(blend);
        k += ((o.intensity ?? 0) * (calm ? CALM : 1) - k) * lag(dt, SWING_TAU);
        path(from, u, k, ea, ta);
        path(to, u, k, eb, tb);
        for (let i = 0; i < 3; i++) {
          d.eye[i] = ea[i] + (eb[i] - ea[i]) * w;
          d.target[i] = ta[i] + (tb[i] - ta[i]) * w;
        }
        d.move = MOVES[to];
      }
      orbitBy(d.eye, drag.yaw, drag.pitch);
      orbitBy(d.target, drag.yaw, 0);
      // Clear of the coin: walk out along the distance field's gradient.
      for (let it = 0; it < 8; it++) {
        const dist = coinDistance(d.eye, o.normal, COIN_R);
        if (dist >= CLEAR) break;
        const h = 1e-5;
        let gx = 0;
        let gy = 0;
        let gz = 0;
        for (let i = 0; i < 3; i++) {
          d.eye[i] += h;
          const g = (coinDistance(d.eye, o.normal, COIN_R) - dist) / h;
          d.eye[i] -= h;
          if (i === 0) gx = g;
          else if (i === 1) gy = g;
          else gz = g;
        }
        const gl = Math.hypot(gx, gy, gz) || 1;
        const push = CLEAR - dist + 1e-6;
        d.eye[0] += (gx / gl) * push;
        d.eye[1] += (gy / gl) * push;
        d.eye[2] += (gz / gl) * push;
      }
      const r = Math.hypot(d.eye[0], d.eye[1], d.eye[2]);
      const rmax = SPHERE_R - WALL_MARGIN;
      if (r > rmax) for (let i = 0; i < 3; i++) d.eye[i] *= rmax / r;
      return d;
    },
  };
  d.step(0, { stepped: false, speed: 0, reduceMotion: false, camera: "auto", normal: [0, 1, 0] });
  return d;
}
