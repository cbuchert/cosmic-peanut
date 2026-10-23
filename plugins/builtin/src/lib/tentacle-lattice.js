// @ts-check
/**
 * Tentacle Lattice's pure logic (the Lattice variant with a Tentacube-style creature at every
 * node). Geometry and motion constants here are mirrored in shaders/lattice/lattice.frag's
 * TENTACLE path — keep them in sync. Nothing is allocated per step.
 *
 * Every node is a rounded cube with six tentacles, one per face, each reaching `reach` of the way
 * toward its neighbour along a strut (opposing tips nearly meet mid-strut). A tentacle is a
 * tapered tube: radius `root` (flared like Tentacube's, ×ROOT_FLARE at the root) down to `tip`,
 * swaying perpendicular to its strut by up to `sway × s^1.5` at fraction s along it (zero at the
 * root, growing to the tip).
 */
import { RISE } from "./lattice-beat.js";
import { PRESETS, ROOT_FLARE, createMorph, createRng, createSpring, effectiveMotion } from "./creature.js";

/** The Tentacle length param: fraction of a cell each tentacle reaches toward its neighbour. */
export const LENGTH = { min: 0.3, max: 0.48, default: 0.42 };
/** Most sideways sway at a tentacle's tip (cells): bounded so the channels stay clear. */
export const SWAY_MAX = 0.14;
/** Most a cube swells with the bass (× its size). */
export const SWELL_MAX = 0.12;
/** Tentacle radius at the root (before the flare) and at the tip; cube half-size (cells). */
const ROOT = 0.075;
const TIP = 0.02;
const HALF = 0.13;

/** @param {number} length the Tentacle length param */
export function tentacleGeometry(length) {
  const n = Number(length);
  const reach = Number.isFinite(n) ? Math.max(LENGTH.min, Math.min(LENGTH.max, n)) : LENGTH.default;
  return { reach, root: ROOT, tip: TIP, half: HALF };
}

/**
 * Tube radius at fraction s (0 root – 1 tip). Mirrored in lattice.frag `tubeRadius`.
 * @param {number} s @param {{ root: number, tip: number }} g
 */
export function tubeRadius(s, g) {
  // A linear taper; the flare is (1 − s)^12 ≈ Tentacube's e^(−12 s), and cheap on the GPU.
  const t2 = (1 - s) * (1 - s);
  const t4 = t2 * t2;
  return (g.root + (g.tip - g.root) * s) * (1 + (ROOT_FLARE - 1) * t4 * t4 * t4);
}

/**
 * The farthest a tentacle's surface gets from its strut's axis at fraction s, swaying by `sway`
 * cells at the tip.
 * @param {number} s @param {{ root: number, tip: number }} g @param {number} sway
 */
export function envelope(s, g, sway) {
  return sway * s ** 1.5 + tubeRadius(s, g);
}

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * L1 distance (cells) from a pulse's node `S` to the midpoint of the strut that leaves node
 * (x, y, z) along `axis` (0 x, 1 y, 2 z). On the rod network that is how far a pulse front has to
 * travel to reach it. Mirrored in lattice.frag.
 * @param {number} x @param {number} y @param {number} z @param {number} axis
 * @param {ArrayLike<number>} S
 */
export function strutDistance(x, y, z, axis, S) {
  return (
    Math.abs(x + (axis === 0 ? 0.5 : 0) - S[0]) +
    Math.abs(y + (axis === 1 ? 0.5 : 0) - S[1]) +
    Math.abs(z + (axis === 2 ? 0.5 : 0) - S[2])
  );
}

/** Handshake shape in the front's lead past a strut (cells): ease in, hold, ease out. */
const HS_IN = -0.35;
const HS_FULL = 0.1;
const HS_HOLD = 0.35;
const HS_OUT = 1.2;

/**
 * How far a strut's two tentacles are reaching for each other (0–1) when a pulse's front is
 * `lead` cells past the strut's midpoint (negative: not there yet). Smoothsteps both ways, so it
 * starts and ends at rest; the front's steady pace turns this into an eased reach (~70 ms at
 * 120 BPM), a short hold, and a slower relax. Multiplied by the pulse's own eased amplitude.
 * Mirrored in lattice.frag `handshake`.
 * @param {number} lead
 */
export function handshake(lead) {
  if (lead <= HS_IN || lead >= HS_OUT) return 0;
  if (lead < HS_FULL) return smooth((lead - HS_IN) / (HS_FULL - HS_IN));
  if (lead < HS_HOLD) return 1;
  return 1 - smooth((lead - HS_HOLD) / (HS_OUT - HS_HOLD));
}

/**
 * Tentacle reach at handshake h: from `reach` to touching its partner mid-strut (tip at 0.5 less
 * its radius, so the caps meet). The sway straightens by (1 − h) as it reaches. Mirrored in
 * lattice.frag.
 * @param {{ reach: number, tip: number }} g @param {number} h 0–1
 */
export function handshakeReach(g, h) {
  return g.reach + h * (0.5 - g.tip - g.reach);
}

/** Twists in flight (uniform array size in lattice.frag). */
export const TWIST_CAP = 4;
/** Twist spring: Tentacube's frequency (Hz), and slower under Reduce motion. */
const TWIST_FREQ = 1.5;
const REDUCED_TWIST_FREQ = 0.6;
/** Fixed spring step (s). */
const TWIST_H = 1 / 240;

/**
 * Damping ratio for the Twitch param: 0.32 at 1 (Tentacube's overshoot), springier above, calmer
 * below (critically damped at 0, where nothing kicks anyway).
 * @param {number} twitch
 */
function twistZeta(twitch) {
  const t = Math.max(0, Math.min(2, twitch));
  return t <= 1 ? 1 - 0.68 * t : 0.32 - 0.1 * (t - 1);
}

/**
 * Local quarter-turn twists: the node a beat pulse starts from twists a quarter turn about one
 * of its axes (seeded), Tentacube's spring twist made gentle — its target eases over RISE (80 ms)
 * so it starts from rest, then the underdamped spring overshoots and settles. A settled quarter
 * turn looks exactly like no turn (the cube and its face texture are quarter-turn symmetric), so
 * the slot is then released (angle 0). `data`: node relative to the origin (x, y, z) and angle;
 * `axis`: 0 x, 1 y, 2 z. Nothing is allocated per step.
 * @param {number} seed
 */
export function createTwists(seed) {
  const rng = createRng(seed);
  const node = new Float64Array(TWIST_CAP * 3);
  const x = new Float64Array(TWIST_CAP);
  const v = new Float64Array(TWIST_CAP);
  const age = new Float64Array(TWIST_CAP).fill(Infinity);
  const k = new Float64Array(TWIST_CAP);
  const c = new Float64Array(TWIST_CAP);
  const live = new Uint8Array(TWIST_CAP);
  let next = 0;
  let acc = 0;
  const quarter = Math.PI / 2;
  const t = {
    data: new Float32Array(TWIST_CAP * 4),
    axis: new Float32Array(TWIST_CAP),
    /**
     * Twist the node nearest `point`.
     * @param {ArrayLike<number>} point @param {number} twitch the Twitch param (after Reduce
     *   motion's effectiveMotion) @param {boolean} reduceMotion
     */
    kick(point, twitch, reduceMotion) {
      if (!(twitch > 0)) return;
      const i = next;
      next = (next + 1) % TWIST_CAP;
      for (let a = 0; a < 3; a++) node[i * 3 + a] = Math.round(point[a]);
      t.axis[i] = Math.min(2, Math.floor(rng.next() * 3));
      const w = 2 * Math.PI * (reduceMotion ? REDUCED_TWIST_FREQ : TWIST_FREQ);
      k[i] = w * w;
      c[i] = 2 * (reduceMotion ? 1 : twistZeta(twitch)) * w;
      x[i] = 0;
      v[i] = 0;
      age[i] = 0;
      live[i] = 1;
    },
    /** @param {number} dt seconds @param {ArrayLike<number>} origin integer cell coordinates */
    step(dt, origin) {
      acc += dt;
      while (acc >= TWIST_H) {
        acc -= TWIST_H;
        for (let i = 0; i < TWIST_CAP; i++) {
          if (!live[i]) continue;
          age[i] += TWIST_H;
          const target = quarter * smooth(age[i] / RISE);
          v[i] += (k[i] * (target - x[i]) - c[i] * v[i]) * TWIST_H;
          x[i] += v[i] * TWIST_H;
          if (age[i] > RISE && Math.abs(x[i] - quarter) < 0.003 && Math.abs(v[i]) < 0.01) live[i] = 0;
        }
      }
      for (let i = 0; i < TWIST_CAP; i++) {
        for (let a = 0; a < 3; a++) t.data[i * 4 + a] = node[i * 3 + a] - origin[a];
        t.data[i * 4 + 3] = live[i] ? x[i] : 0;
      }
      return t;
    },
  };
  return t;
}

/** Under Reduce motion: sway amplitude and the sway's pace are scaled by this. */
export const REDUCED_SWAY = 0.3;
/** Seconds per easing stage of the ripple (two stages: no snap). */
const RIPPLE_TAU = 0.12;

/**
 * The tentacles' sway: `amp` (cells at the tip, ≤ SWAY_MAX) from the Sway param, stronger with
 * the mids and highs (`ripple`, 0–1, eased); `clock` runs the travelling root→tip wave, faster
 * with the ripple. Reduce motion damps both. lattice.frag gives each tentacle a hashed phase and
 * direction, so neighbours never move in lockstep.
 */
export function createSway() {
  let mid = 0;
  const s = {
    amp: 0,
    ripple: 0,
    clock: 0,
    /**
     * @param {Float32Array} bands `audio.bands` @param {number} dt @param {number} sway the Sway
     * param (0–2) @param {number} reactivity @param {boolean} reduceMotion
     */
    step(bands, dt, sway, reactivity, reduceMotion) {
      const n = bands.length;
      const lo = Math.floor((16 * n) / 64);
      let e = 0;
      for (let i = lo; i < n; i++) e += bands[i];
      e /= Math.max(1, n - lo);
      const target = Math.min(1, 2 * e * Math.max(0, Math.min(2, reactivity)));
      const k = 1 - Math.exp(-dt / RIPPLE_TAU);
      mid += (target - mid) * k;
      s.ripple += (mid - s.ripple) * k;
      const calm = reduceMotion ? REDUCED_SWAY : 1;
      const sw = Math.max(0, Math.min(2, sway));
      s.amp = Math.min(SWAY_MAX, 0.5 * SWAY_MAX * sw * (0.55 + 0.45 * s.ripple)) * calm;
      s.clock += dt * (1 + 1.5 * s.ripple) * calm;
      return s;
    },
  };
  return s;
}

/** Bass swell spring (Hz, damping), stepped at a fixed rate. */
const SWELL_FREQ = 2;
const SWELL_ZETA = 0.7;
const SWELL_H = 1 / 240;
/** Under Reduce motion the swell is scaled by this. */
const REDUCED_SWELL = 0.3;

/**
 * The bass swell (Tentacube's, made local): bass above its average (bassAtt > 1) pushes a spring,
 * and `value` (0–SWELL_MAX, × the cube's size) goes to the nodes nearest the camera, weighted by
 * swellWeight.
 */
export function createSwell() {
  const spring = createSpring(SWELL_FREQ, SWELL_ZETA);
  let acc = 0;
  const s = {
    value: 0,
    /**
     * @param {number} bassAtt `audio.bassAtt` @param {number} dt @param {number} reactivity
     * @param {boolean} reduceMotion
     */
    step(bassAtt, dt, reactivity, reduceMotion) {
      const target = Math.min(1, Math.max(0, (bassAtt || 0) - 1) * 0.6 * Math.max(0, Math.min(2, reactivity)));
      acc += dt;
      while (acc >= SWELL_H) {
        acc -= SWELL_H;
        spring.step(SWELL_H, target);
      }
      s.value = SWELL_MAX * Math.max(0, Math.min(1, spring.x)) * (reduceMotion ? REDUCED_SWELL : 1);
      return s.value;
    },
  };
  return s;
}

/**
 * How much of the swell a node gets at `d` cells from the camera: the nearest nodes (≥ 0.6 away)
 * most, nothing two or three cells on. Mirrored in lattice.frag.
 * @param {number} d
 */
export function swellWeight(d) {
  return Math.exp(-0.9 * d * d);
}

/** The Material param's options: "auto" walks Tentacube's presets in order. */
export const MATERIALS = ["auto", ...PRESETS];

/**
 * The material sequencer: Tentacube's createMorph at its "slow" pace — with "auto", the next
 * preset every 16 bars (or after a sustained energy change), crossfaded with a smoothstep;
 * a fixed material fades to it and stays. `step` returns the weights of chrome, iridescent,
 * emissive, obsidian (sum 1), for lattice.frag's `u_mat`.
 */
export function createMaterials() {
  const morph = createMorph();
  return {
    /**
     * @param {number} dt @param {unknown} material the Material param @param {number} energy
     * `audio.rms` @param {number} bpm `audio.bpm` (0 = unknown, 120 assumed)
     */
    step(dt, material, energy, bpm) {
      const name = MATERIALS.includes(String(material)) ? String(material) : "auto";
      morph.step(dt, "slow", name, energy, bpm);
      return morph.weights;
    },
  };
}

/** @param {string} id `ctx.id` → whether this is Tentacle Lattice (else plain Lattice) */
export function isTentacle(id) {
  return id === "tentacle-lattice";
}

/** Manifest defaults of Sway and Twitch. */
const DEFAULT_SWAY = 1;
const DEFAULT_TWITCH = 1;
const motionOut = { twitch: 0, drift: 0, tumble: 0 };

/** A 0–2 param value, or `d` when it isn't a number. @param {unknown} v @param {number} d */
function num(v, d) {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : d;
}

/**
 * Sway and Twitch, clamped to 0–2 (non-numbers → defaults). Reduce motion calms Twitch through
 * Tentacube's effectiveMotion (only at its default); the sway is damped in createSway.
 * @param {{ sway?: unknown, twitch?: unknown }} p @param {boolean} reduceMotion
 * @param {{ sway: number, twitch: number }} out
 */
export function motionParams(p, reduceMotion, out) {
  out.sway = num(p.sway, DEFAULT_SWAY);
  out.twitch = effectiveMotion(num(p.twitch, DEFAULT_TWITCH), reduceMotion, motionOut).twitch;
  return out;
}

/** Samples and slack for envelopeMax: the envelope's slope is < 0.3 per unit s. */
const ENV_SAMPLES = 256;
const ENV_SLACK = 0.3 / (2 * ENV_SAMPLES);

/**
 * The farthest any tentacle surface gets from its strut's axis at tip sway `amp` (lattice.frag's
 * u_env, which bounds the march): the envelope's maximum over the tentacle, sampled finely plus
 * the most it can rise between samples. Allocation-free; cheap enough per frame.
 * @param {{ root: number, tip: number }} g @param {number} amp
 */
export function envelopeMax(g, amp) {
  let m = 0;
  for (let i = 0; i <= ENV_SAMPLES; i++) m = Math.max(m, envelope(i / ENV_SAMPLES, g, amp));
  return m + ENV_SLACK;
}
