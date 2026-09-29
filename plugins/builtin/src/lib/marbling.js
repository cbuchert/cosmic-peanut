// @ts-check
/**
 * Marbling's pure logic, mirrored by shaders/marbling/sim.frag: the mathematical-marbling maps
 * (Jaffer et al.) and their exact inverses, the per-frame pour scheduler, palettes, renew, resize.
 *
 * Coordinates are "page units": y from 0 (bottom) to 1 (top), x from 0 to the aspect ratio.
 */
import { createFlashLimiter } from "./flash.js";

/**
 * A drop of radius √r2 landing at (cx, cy): every existing point p moves to
 * c + (p − c)·√(1 + r²/|p − c|²), so |p' − c|² = |p − c|² + r² (area is conserved outside it).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r2 squared radius
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out [x, y]
 */
export function dropForward(cx, cy, r2, px, py, out) {
  const dx = px - cx;
  const dy = py - cy;
  const q = dx * dx + dy * dy;
  const s = q > 0 ? Math.sqrt(1 + r2 / q) : 1;
  out[0] = cx + dx * s;
  out[1] = cy + dy * s;
  return out;
}

/**
 * Exact inverse of {@link dropForward}: where the paint now at p was before the drop. Points
 * inside the drop (|p − c|² < r²) have no pre-image — they hold the drop's own paint — so the
 * function returns true and writes c; otherwise it writes c + (p − c)·√(1 − r²/|p − c|²).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r2 squared radius
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out [x, y]
 * @returns {boolean} p lies inside the drop
 */
export function dropInverse(cx, cy, r2, px, py, out) {
  const dx = px - cx;
  const dy = py - cy;
  const q = dx * dx + dy * dy;
  if (q < r2) {
    out[0] = cx;
    out[1] = cy;
    return true;
  }
  const s = q > 0 ? Math.sqrt(1 - r2 / q) : 0;
  out[0] = cx + dx * s;
  out[1] = cy + dy * s;
  return false;
}

/**
 * Largest contraction factor |v|·max|∇φ| a stylus step may have, so {@link dragInverse}'s
 * fixed-point iteration converges fast (error × 0.25 per step); DRAG_ITERS steps reach < 1e-4.
 */
export const DRAG_CONTRACTION = 0.25;
export const DRAG_ITERS = 7;

/**
 * One step of the stylus (a rake tine) moving by v from s: paint near it is dragged along,
 * p' = p + v·exp(−|p − s|²·invS2), a Gaussian falloff of width 1/√invS2.
 * @param {number} sx
 * @param {number} sy
 * @param {number} vx
 * @param {number} vy
 * @param {number} invS2 1 / σ²
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out
 */
export function dragForward(sx, sy, vx, vy, invS2, px, py, out) {
  const dx = px - sx;
  const dy = py - sy;
  const f = Math.exp(-(dx * dx + dy * dy) * invS2);
  out[0] = px + vx * f;
  out[1] = py + vy * f;
  return out;
}

/**
 * Inverse of {@link dragForward} by fixed-point iteration p ← p' − v·φ(p) (a contraction once v
 * is clamped by {@link clampDrag}). Mirrored in sim.frag.
 * @param {number} sx
 * @param {number} sy
 * @param {number} vx
 * @param {number} vy
 * @param {number} invS2
 * @param {number} px
 * @param {number} py
 * @param {Float64Array | number[]} out
 */
export function dragInverse(sx, sy, vx, vy, invS2, px, py, out) {
  let x = px;
  let y = py;
  for (let i = 0; i < DRAG_ITERS; i++) {
    const dx = x - sx;
    const dy = y - sy;
    const f = Math.exp(-(dx * dx + dy * dy) * invS2);
    x = px - vx * f;
    y = py - vy * f;
  }
  out[0] = x;
  out[1] = y;
  return out;
}

/**
 * Shorten a stylus step v (in place) so the drag stays invertible: |∇φ| peaks at √(2·invS2/e).
 * @param {number} invS2
 * @param {Float64Array | Float32Array | number[]} v [vx, vy]
 */
export function clampDrag(invS2, v) {
  const lim = DRAG_CONTRACTION / Math.sqrt((2 * invS2) / Math.E);
  const len = Math.hypot(v[0], v[1]);
  if (len > lim) {
    v[0] *= lim / len;
    v[1] *= lim / len;
  }
  return v;
}

/**
 * Seeded PRNG (mulberry32): drop positions and choices are deterministic given the audio and time.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function createRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Band-index edges of the three spectral regions over the host's 64 log bands (30 Hz – 16 kHz):
 * low [0, 17) below ~150 Hz (kicks, bass), mid [17, 43) to ~2 kHz (snares, voice), high above.
 */
export const REGIONS = [0, 17, 43, 64];

/**
 * Which region hit hardest: the largest mean rise of its bands since the previous frame.
 * @param {ArrayLike<number>} bands this frame's `audio.bands`
 * @param {ArrayLike<number>} prev last frame's copy
 * @returns {number} 0 low, 1 mid, 2 high
 */
export function strongestRegion(bands, prev) {
  let best = 0;
  let bestRise = -1;
  for (let r = 0; r < 3; r++) {
    let rise = 0;
    for (let i = REGIONS[r]; i < REGIONS[r + 1]; i++) {
      const d = bands[i] - prev[i];
      if (d > 0) rise += d;
    }
    rise /= REGIONS[r + 1] - REGIONS[r];
    if (rise > bestRise) {
      bestRise = rise;
      best = r;
    }
  }
  return best;
}

/**
 * @typedef {object} Palette
 * @property {number[]} paper cream paper (sRGB 0–1), shown where no ink lies (Paper "cream")
 * @property {number[][]} inks 0 veins (dark), 1 body (main cells), 2 light (hats, nested cells),
 *   3 deep (snares, nested cells). The sim texture stores the amount of each ink per pixel.
 */

/** @type {Record<string, Palette>} */
export const PALETTES = {
  beast: {
    paper: [0.94, 0.9, 0.8],
    inks: [
      [0.05, 0.03, 0.03],
      [0.8, 0.22, 0.15],
      [0.9, 0.42, 0.26],
      [0.6, 0.12, 0.09],
    ],
  },
  indigo: {
    paper: [0.93, 0.91, 0.86],
    inks: [
      [0.03, 0.04, 0.1],
      [0.17, 0.25, 0.58],
      [0.42, 0.55, 0.82],
      [0.1, 0.14, 0.38],
    ],
  },
  emerald: {
    paper: [0.94, 0.92, 0.84],
    inks: [
      [0.02, 0.06, 0.04],
      [0.1, 0.47, 0.31],
      [0.35, 0.7, 0.5],
      [0.05, 0.3, 0.2],
    ],
  },
  gold: {
    paper: [0.95, 0.92, 0.83],
    inks: [
      [0.06, 0.04, 0.02],
      [0.8, 0.58, 0.14],
      [0.93, 0.79, 0.4],
      [0.58, 0.38, 0.08],
    ],
  },
};

/** @param {unknown} name */
export function paletteOf(name) {
  return (typeof name === "string" && Object.hasOwn(PALETTES, name) && PALETTES[name]) || PALETTES.beast;
}

/**
 * The region with the highest mean band level right now.
 * @param {ArrayLike<number>} bands
 */
function loudestRegion(bands) {
  let best = 0;
  let bestLevel = -1;
  for (let r = 0; r < 3; r++) {
    let sum = 0;
    for (let i = REGIONS[r]; i < REGIONS[r + 1]; i++) sum += bands[i];
    const level = sum / (REGIONS[r + 1] - REGIONS[r]);
    if (level > bestLevel) {
      bestLevel = level;
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Scheduler: turns audio into this frame's marbling events (at most MAX_EVENTS, constant cost)
// ---------------------------------------------------------------------------------------------

/** Events applied per frame (uniform array length in sim.frag). */
export const MAX_EVENTS = 16;
/** Drops being poured at once (each emits one DROP slice per frame). */
export const MAX_POURS = 12;
export const EV_DROP = 1;
export const EV_DRAG = 2;
export const EV_SHIFT = 3;

/**
 * Per-region drop recipe (page units: the page is 1 tall). radius: base radius; rimT: thickness of
 * the vein-ink ring poured first (rimInk), so each cell ends up outlined; pour: seconds a drop
 * takes to spread; spread: fraction of the page its centre may land in; sat: chance of 1..maxSat
 * smaller satellite drops landing inside it just after (nested cells); clear: chance the drop is
 * clear (paper-coloured, no rim) — the cream specks.
 */
const RECIPES = [
  { radius: 0.075, ink: 1, rimInk: 0, rimT: 0.0035, pour: 0.3, spread: 0.7, sat: 0.85, maxSat: 3, clear: 0 }, // low: kicks, bass
  { radius: 0.045, ink: 3, rimInk: 0, rimT: 0.006, pour: 0.2, spread: 0.85, sat: 0.5, maxSat: 2, clear: 0 }, // mid: snares
  { radius: 0.017, ink: 2, rimInk: 0, rimT: 0.0018, pour: 0.1, spread: 1, sat: 0, maxSat: 0, clear: 0.3 }, // high: hats
];

/**
 * @typedef {object} PourAudio The fields of `audio` the scheduler reads.
 * @property {boolean} onset
 * @property {number} onsetStrength
 * @property {ArrayLike<number>} bands
 * @property {number} bassAtt
 * @property {number} rms
 * @property {number} peak
 * @property {number} centroid
 * @property {boolean} silent
 */
/**
 * @typedef {object} PourParams
 * @property {number} pour pour-rate multiplier
 * @property {number} size drop-size multiplier
 * @property {number} rake stylus (stroke) amount
 * @property {number} reactivity how strongly hits scale drops
 * @property {number} renew renew-speed multiplier
 */
/**
 * @typedef {object} PourEnv
 * @property {number} aspect page width / height
 * @property {number} pxPerUnit sim texture height in pixels (drift moves whole pixels)
 * @property {boolean} reduceFlashing
 * @property {boolean} reduceMotion
 */

/** Loudness below which the auto-gain reference never falls, and the absolute "loud" level. */
const RMS_FLOOR = 0.05;
const RMS_LOUD = 0.2;

/** Stylus: Gaussian drag width (σ = 0.012 page), how much of its motion the paint follows, how
 * far it runs past the page edges before turning, and the spacing of its clear drops. */
const STYLUS_INV_S2 = 1 / (0.012 * 0.012);
const STYLUS_GRIP = 0.9;
const STYLUS_MARGIN = 0.03;
const STYLUS_SPACING = 0.02;

/** Renew: drift speed (page heights/s at Renew 1), mean seconds between large clear drops at
 * Renew 1 (scaled 0.6× when quiet … 1.4× when loud), and how long one takes to bloom open. */
const DRIFT_SPEED = 0.003;
const CLEAR_EVERY = 30;
const CLEAR_POUR = 2.5;

/** @param {number} x */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The pour scheduler. Each `step` rewrites evA–evD with this frame's events, oldest first:
 * - DROP  evA (1, x, y, R²)   evB (cellR², 0, 0, 0): a concentric slice of a drop being poured;
 *   inside √cellR² takes evC's ink, the ring out to R takes evD's (the rim, poured first).
 * - DRAG  evA (2, sx, sy, 1/σ²) evB (vx, vy, 0, 0): the stylus step (see dragForward).
 * - SHIFT evA (3, dx, dy, 0): the whole page drifts by whole sim pixels.
 * Inks are 4-vectors of ink amounts (one-hot; all zero = clear, i.e. paper).
 * @param {number} seed
 */
export function createMarbler(seed) {
  const rand = createRng(seed);
  const evA = new Float32Array(MAX_EVENTS * 4);
  const evB = new Float32Array(MAX_EVENTS * 4);
  const evC = new Float32Array(MAX_EVENTS * 4);
  const evD = new Float32Array(MAX_EVENTS * 4);
  const prevBands = new Float32Array(64);
  const pours = Array.from({ length: MAX_POURS }, () => ({
    state: 0, // 0 free, 1 waiting (delay), 2 pouring
    delay: 0,
    x: 0,
    y: 0,
    total: 0,
    done: 0,
    rim2: 0,
    ink: -1,
    rimInk: -1,
    dur: 0,
    t: 0,
  }));
  let now = 0;
  let lastDrop = -1e9;
  let rmsS = 0;
  let ref = RMS_FLOOR;
  let drizzle = 0;
  // The stylus: position, direction of travel, distance travelled, last clear-drop deposit.
  let sx = -1;
  let sy = 0.5;
  let dir = 1;
  let travelled = 0;
  let deposited = 0;
  let centroidS = 0.1;
  let peakS = 0;
  const v = new Float64Array(2);
  // Renew: sub-pixel drift accumulator (sim pixels) and the next large clear drop.
  let driftX = 0;
  let driftY = 0;
  const flash = createFlashLimiter();
  let kick = 0;
  let clearClock = 0;
  let nextClear = CLEAR_EVERY;

  /**
   * Queue a drop. Returns the slot, or -1 when every slot is busy (the drop is skipped: the cap).
   * @param {number} x @param {number} y @param {number} r @param {number} rimT
   * @param {number} ink @param {number} rimInk @param {number} dur @param {number} delay
   */
  function spawn(x, y, r, rimT, ink, rimInk, dur, delay) {
    for (let i = 0; i < MAX_POURS; i++) {
      const p = pours[i];
      if (p.state !== 0) continue;
      p.state = delay > 0 ? 1 : 2;
      p.delay = delay;
      p.x = x;
      p.y = y;
      p.rim2 = rimT > 0 ? 2 * r * rimT + rimT * rimT : 0;
      p.total = r * r + p.rim2;
      p.done = 0;
      p.ink = ink;
      p.rimInk = rimInk;
      p.dur = Math.max(1e-3, dur);
      p.t = 0;
      return i;
    }
    return -1;
  }

  /**
   * A drop (plus maybe satellites) for a hit in `region`, sized by the hit and the params.
   * @param {number} region @param {number} scale @param {PourAudio} audio
   * @param {PourParams} params @param {PourEnv} env
   */
  function dropFrom(region, scale, audio, params, env) {
    lastDrop = now;
    const rc = RECIPES[region];
    const hit = clamp01(0.5 * audio.onsetStrength + 0.5 * (region === 0 ? audio.bassAtt / 2 : 0.5));
    const r = scale * rc.radius * params.size * (0.7 + 0.6 * params.reactivity * hit);
    const x = env.aspect * (0.5 + (rand() - 0.5) * rc.spread);
    const y = 0.5 + (rand() - 0.5) * rc.spread;
    if (rand() < rc.clear) spawn(x, y, r, 0, -1, -1, rc.pour, 0);
    else spawn(x, y, r, rc.rimT, rc.ink, rc.rimInk, rc.pour, 0);
    if (scale === 1 && rand() < rc.sat) {
      const k = 1 + Math.floor(rand() * rc.maxSat);
      for (let j = 0; j < k; j++) {
        const a = rand() * 2 * Math.PI;
        const d = 0.4 * r * Math.sqrt(rand());
        const light = rand() < 0.55;
        const sr = r * (0.2 + 0.3 * rand());
        spawn(
          x + d * Math.cos(a),
          y + d * Math.sin(a),
          sr,
          0.0015,
          light ? 2 : 3,
          light ? 3 : 0,
          rc.pour * 0.6,
          0.15 + 0.3 * rand(),
        );
      }
    }
  }

  /** @param {Float32Array} arr @param {number} i @param {number} ink */
  function writeInk(arr, i, ink) {
    for (let k = 0; k < 4; k++) arr[i * 4 + k] = k === ink ? 1 : 0;
  }

  const m = {
    evA,
    evB,
    evC,
    evD,
    /** Number of events this frame. */
    count: 0,
    /** Smoothed loudness 0–1 that sets the pour rate. */
    energy: 0,
    /** 0–1 sheen pulse on hits (≤ 3 rises/s under reduceFlashing). */
    sheen: 0,
    /**
     * @param {PourAudio} audio
     * @param {number} dt seconds
     * @param {PourParams} params
     * @param {PourEnv} env
     */
    step(audio, dt, params, env) {
      now += dt;
      const bands = audio.bands;
      // Energy 0–1: half relative to the recent loudest (auto-gain), half absolute.
      const rms = audio.silent ? 0 : audio.rms;
      rmsS += (rms - rmsS) * (1 - Math.exp(-dt / 0.3));
      ref = Math.max(RMS_FLOOR, rmsS, ref * Math.exp(-dt / 8));
      const energy = clamp01(0.5 * (rmsS / ref) + 0.5 * (rmsS / RMS_LOUD));
      m.energy = energy;
      const pour = Math.max(0.05, params.pour);

      let region = -1;
      let scale = 1;
      if (audio.onset && !audio.silent && now - lastDrop >= (0.5 - 0.38 * energy) / pour) {
        region = strongestRegion(bands, prevBands);
      }
      // Loud passages also drizzle smaller drops between the hits.
      drizzle += dt * pour * (energy > 0.3 ? 2.5 * energy * energy : 0);
      if (region < 0 && drizzle >= 1 && !audio.silent) {
        drizzle -= 1;
        region = loudestRegion(bands);
        scale = 0.6;
      }
      if (drizzle > 1) drizzle = 1;
      if (region >= 0) dropFrom(region, scale, audio, params, env);

      // A wet sheen on each hit (the composite brightens the page a little): flash-limited.
      kick = audio.onset && !audio.silent ? clamp01(audio.onsetStrength * params.reactivity) : kick * Math.exp(-dt * 5);
      m.sheen = flash.step(kick, dt, env.reduceFlashing);

      let n = 0;
      // Renew. The page drifts slowly, by whole sim pixels only (an exact copy, no resampling
      // blur), pushing old paint off one edge and bringing fresh paper in at the other; and now
      // and then (sooner when it's quiet) a large clear drop blooms open over a few seconds.
      const renew = Math.max(0, params.renew);
      if (renew > 0) {
        const a = 0.9 + 0.05 * now;
        const speed = renew * DRIFT_SPEED * dt * env.pxPerUnit;
        driftX += speed * Math.cos(a);
        driftY += speed * Math.sin(a);
        const ix = Math.trunc(driftX);
        const iy = Math.trunc(driftY);
        if (ix !== 0 || iy !== 0) {
          driftX -= ix;
          driftY -= iy;
          evA[0] = EV_SHIFT;
          evA[1] = ix / env.pxPerUnit;
          evA[2] = iy / env.pxPerUnit;
          evA[3] = 0;
          n = 1;
        }
        clearClock += dt * renew;
        if (clearClock >= nextClear) {
          nextClear = clearClock + CLEAR_EVERY * (0.6 + 0.8 * energy) * (0.7 + 0.6 * rand());
          const x = env.aspect * (0.15 + 0.7 * rand());
          const y = 0.2 + 0.6 * rand();
          spawn(x, y, 0.1 + 0.08 * rand(), 0, -1, -1, CLEAR_POUR, 0);
        }
      }

      // The stylus rakes through the paint: height from the (smoothed) spectral centroid, a
      // wobble from the waveform's peak, speed from the energy; it drips clear paper as it goes.
      centroidS += (audio.centroid - centroidS) * (1 - Math.exp(-dt / 0.6));
      peakS += ((audio.silent ? 0 : audio.peak) - peakS) * (1 - Math.exp(-dt / 0.3));
      if (sx < 0) sx = env.aspect * 0.5;
      const rake = params.rake;
      if (rake > 0 && !audio.silent && energy > 0.02) {
        const x0 = sx;
        const y0 = sy;
        sx += dir * rake * (0.04 + 0.16 * energy) * dt;
        if (sx > env.aspect + STYLUS_MARGIN) dir = -1;
        if (sx < -STYLUS_MARGIN) dir = 1;
        const target = 0.12 + 0.76 * clamp01(centroidS * 2.5) + 0.07 * peakS * Math.sin(travelled * 11);
        sy += (target - sy) * (1 - Math.exp(-dt / 0.35));
        v[0] = (sx - x0) * STYLUS_GRIP;
        v[1] = (sy - y0) * STYLUS_GRIP;
        clampDrag(STYLUS_INV_S2, v);
        evA[n * 4] = EV_DRAG;
        evA[n * 4 + 1] = x0;
        evA[n * 4 + 2] = y0;
        evA[n * 4 + 3] = STYLUS_INV_S2;
        evB[n * 4] = v[0];
        evB[n * 4 + 1] = v[1];
        evB[n * 4 + 2] = 0;
        evB[n * 4 + 3] = 0;
        n++;
        travelled += Math.hypot(sx - x0, sy - y0);
        if (travelled - deposited >= STYLUS_SPACING) {
          deposited = travelled;
          const r = 0.011 * (0.7 + 0.6 * energy) * Math.min(1.5, Math.sqrt(rake));
          spawn(sx, sy, r, 0, -1, -1, 0.12, 0);
        }
      }
      for (let i = 0; i < 64; i++) prevBands[i] = bands[i] ?? 0;

      // Emit this frame's slice of every drop being poured.
      for (let i = 0; i < MAX_POURS && n < MAX_EVENTS; i++) {
        const p = pours[i];
        if (p.state === 1) {
          p.delay -= dt;
          if (p.delay > 0) continue;
          p.state = 2;
        }
        if (p.state !== 2) continue;
        p.t += dt;
        const u = clamp01(p.t / p.dur);
        const done = p.total * (1 - (1 - u) * (1 - u));
        const slice = done - p.done;
        if (slice > 0) {
          const rimPart = Math.max(0, Math.min(done, p.rim2) - p.done);
          evA[n * 4] = EV_DROP;
          evA[n * 4 + 1] = p.x;
          evA[n * 4 + 2] = p.y;
          evA[n * 4 + 3] = slice;
          evB[n * 4] = slice - rimPart;
          evB[n * 4 + 1] = 0;
          evB[n * 4 + 2] = 0;
          evB[n * 4 + 3] = 0;
          writeInk(evC, n, p.ink);
          writeInk(evD, n, p.rimInk);
          n++;
        }
        p.done = done;
        if (u >= 1) p.state = 0;
      }
      m.count = n;
    },
  };
  return m;
}

/** Manifest defaults of the numeric params (tests/test_builtin_manifests.py pins them). */
export const DEFAULTS = Object.freeze({ pour: 1, size: 1, rake: 1, reactivity: 1, renew: 1 });
/** What Reduce motion uses instead of a default: a calmer pour, a gentler rake, slower renewal. */
const REDUCED = { pour: 0.6, rake: 0.4, renew: 0.5 };
const PARAM_KEYS = /** @type {(keyof PourParams)[]} */ (Object.keys(DEFAULTS));

/**
 * Copy the live numeric params into `out` (defaults for anything missing or not a number). Under
 * Reduce motion, pour/rake/renew that sit at their defaults take the calmer REDUCED values.
 * Allocation-free (called every frame).
 * @param {Readonly<Record<string, unknown>>} params `ctx.params`
 * @param {boolean} reduceMotion
 * @param {PourParams} out
 */
export function effectiveParams(params, reduceMotion, out) {
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    const k = PARAM_KEYS[i];
    const v = params[k];
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : DEFAULTS[k];
  }
  if (reduceMotion) {
    if (out.pour === DEFAULTS.pour) out.pour = REDUCED.pour;
    if (out.rake === DEFAULTS.rake) out.rake = REDUCED.rake;
    if (out.renew === DEFAULTS.renew) out.renew = REDUCED.renew;
  }
  return out;
}
