// @ts-check
/**
 * Ridge-line math for Pulsar (the Unknown Pleasures plot). Pure functions over preallocated
 * typed arrays; nothing here allocates after setup.
 */

/** Half-width of the central eruption, as a fraction of the line (the cover's is ≈ 0.2–0.25). */
export const ENV_HALF_WIDTH = 0.25;
/** Band read at the bump's edges; the centre reads band 0 (bass). */
const MAX_BAND = 48;
/** > 1 sharpens peaks relative to the slopes between them. */
const SHARPNESS = 1.4;
/** Coarse jitter knots across the whole line (≈ half of them fall inside the bump). */
const KNOTS = 22;
/** Waveform samples between knots: far enough apart to be independent. */
const KNOT_STRIDE = 89;
/** Coarse jitter depth: peak heights vary by ±JITTER. */
const JITTER = 0.75;
/** Fine, per-point jaggedness inside the bump, relative to the local height. */
const JAG = 0.06;
/** Most bands the right half reads offset from the left. */
const SKEW = 4;
/** Waveform-driven wiggle everywhere (units of full peak height). */
const WIGGLE = 0.012;
/** Always-on tiny wiggle (units of full peak height) so silent lines aren't ruled straight. */
const WIGGLE_FLOOR = 0.004;

/**
 * Fill `out` with a raised-cosine bump centred on the middle of the line.
 * @param {Float32Array} out one value per point, x from 0 to 1
 * @param {number} halfWidth half the bump's width, as a fraction of the line
 */
export function centralEnvelope(out, halfWidth) {
  const last = out.length - 1;
  for (let i = 0; i <= last; i++) {
    const d = Math.abs(i / last - 0.5) / halfWidth;
    out[i] = d < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * d) : 0;
  }
}

/**
 * Band level at a fractional band index, linearly interpolated and clamped to the ends.
 * @param {ArrayLike<number>} bands
 * @param {number} pos
 */
export function bandAt(bands, pos) {
  const last = bands.length - 1;
  if (pos <= 0) return bands[0];
  if (pos >= last) return bands[last];
  const i = Math.floor(pos);
  const f = pos - i;
  return bands[i] + (bands[i + 1] - bands[i]) * f;
}

/**
 * Advance the scroll by `dt`: returns how many whole lines to push now and leaves the leftover
 * fraction of a line in `state.frac` (0 ≤ frac < 1) so drawing can offset by it.
 * @param {{ frac: number }} state
 * @param {number} dt seconds
 * @param {number} rate lines per second
 * @param {number} max cap on lines per call (the history length)
 */
export function advanceScroll(state, dt, rate, max) {
  const acc = state.frac + dt * rate;
  const n = Math.floor(acc);
  state.frac = acc - n;
  return n < max ? n : max;
}

/**
 * History of `lines` rows of `points` values in one preallocated buffer.
 * @param {number} lines
 * @param {number} points
 */
export function createRing(lines, points) {
  return { data: new Float32Array(lines * points), lines, points, head: 0 };
}

/**
 * Make room for a new newest row and return its offset into `ring.data` (the caller fills it).
 * @param {ReturnType<typeof createRing>} ring
 */
export function ringPush(ring) {
  ring.head = (ring.head + 1) % ring.lines;
  return ring.head * ring.points;
}

/**
 * Offset of the row `age` pushes old (0 = newest).
 * @param {ReturnType<typeof createRing>} ring
 * @param {number} age 0 … lines − 1
 */
export function ringRow(ring, age) {
  return ((ring.head - age + ring.lines) % ring.lines) * ring.points;
}

/**
 * A new ring of `lines` rows holding the newest rows of `ring` (not for use per frame).
 * @param {ReturnType<typeof createRing>} ring
 * @param {number} lines
 */
export function resizeRing(ring, lines) {
  const next = createRing(lines, ring.points);
  const keep = Math.min(lines, ring.lines);
  // Oldest kept row first, so the newest ends up at the head.
  for (let age = keep - 1; age >= 0; age--) {
    const from = ringRow(ring, age);
    next.data.set(ring.data.subarray(from, from + ring.points), ringPush(next));
  }
  return next;
}

const GAIN_TARGET = 0.85;
/** Levels below this aren't boosted further: max gain = GAIN_TARGET / GAIN_FLOOR. */
const GAIN_FLOOR = 0.15;
const GAIN_RISE = 1;
const GAIN_FALL = 5;

/**
 * Slow automatic gain: follows the loudness of the incoming profile (rise ≈ 1 s, fall ≈ 5 s) and
 * returns the factor that brings it to a steady peak height, bounded so silence isn't amplified.
 * @param {{ level: number }} state
 * @param {number} level current peak of the raw profile, ≈0–1
 * @param {number} dt seconds
 */
export function stepGain(state, level, dt) {
  const tau = level > state.level ? GAIN_RISE : GAIN_FALL;
  state.level += (level - state.level) * (1 - Math.exp(-dt / tau));
  return GAIN_TARGET / Math.max(state.level, GAIN_FLOOR);
}

/**
 * Build one ridge from one moment of audio into `out[offset … offset + env.length)`, in units of
 * the full peak height (≈0–1.5; the tails stay near 0).
 * @param {Float32Array} out
 * @param {number} offset
 * @param {Float32Array} env central envelope, one value per point (see {@link centralEnvelope})
 * @param {ArrayLike<number>} bands the 64 host bands, 0–1
 * @param {ArrayLike<number>} wave the host waveform, −1..1
 * @param {number} gain from {@link stepGain}
 * @param {number} seed integer that differs per line (varies the jitter between lines)
 * @returns {number} the raw, pre-gain peak of the enveloped bands (feed it to stepGain)
 */
export function buildLine(out, offset, env, bands, wave, gain, seed) {
  const last = env.length - 1;
  const n = wave.length;
  const stride = Math.max(1, Math.floor(n / (last + 1)));
  const phase = (seed * 37) % stride;
  // Jitter reads the waveform's shape, not its loudness: normalize by the sampled peak.
  let wmax = 1e-3;
  for (let i = 0; i <= last; i++) {
    const a = Math.abs(wave[i * stride + phase]);
    if (a > wmax) wmax = a;
  }
  const knotBase = seed * 53;
  const skew = SKEW * (wave[(seed * 131 + 17) % n] / wmax);
  let raw = 0;
  for (let i = 0; i <= last; i++) {
    const x = i / last;
    const w = wave[i * stride + phase];
    const e = env[i];
    let y = WIGGLE_FLOOR * hash(seed, i) + WIGGLE * (w > 0.33 ? 1 : w < -0.33 ? -1 : w * 3);
    if (e > 0) {
      const t = Math.abs(x - 0.5) / ENV_HALF_WIDTH;
      // The right half reads the spectrum a few bands off from the left: no mirror image.
      const r = e * bandAt(bands, t * MAX_BAND + (x > 0.5 ? skew : 0));
      if (r > raw) raw = r;
      // Coarse multiplicative jitter, smoothly interpolated between waveform-picked knots.
      const u = x * KNOTS;
      const j = Math.floor(u);
      let f = u - j;
      f = f * f * (3 - 2 * f);
      const k0 = wave[(j * KNOT_STRIDE + knotBase) % n] / wmax;
      const k1 = wave[((j + 1) * KNOT_STRIDE + knotBase) % n] / wmax;
      const m = 1 + JITTER * (k0 + (k1 - k0) * f);
      const g = gain * r;
      y += Math.pow(g * (m > 0 ? m : 0), SHARPNESS) + JAG * g * (w / wmax);
    }
    out[offset + i] = y;
  }
  return raw;
}

/**
 * Deterministic noise in −1..1 for (seed, i).
 * @param {number} seed
 * @param {number} i
 */
function hash(seed, i) {
  const h = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return 2 * (h - Math.floor(h)) - 1;
}
