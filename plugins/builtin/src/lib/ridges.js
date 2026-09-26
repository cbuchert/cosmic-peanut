// @ts-check
/**
 * Ridge-line math for Pulsar (the Unknown Pleasures plot). Pure functions over preallocated
 * typed arrays; nothing here allocates after setup.
 */

/** Half-width of the central eruption, as a fraction of the line (the cover's is ≈ 0.2–0.25). */
export const ENV_HALF_WIDTH = 0.27;
/** Fraction of the envelope's half-width that is flat at full height. */
const PLATEAU = 0.2;
/** Band read at the bump's edges; the centre reads band 0 (bass). */
const MAX_BAND = 48;
/** Relative boost of the bump's edges (higher bands) over its centre (bass). */
const TILT = 0.25;
/** > 1 sharpens peaks relative to the slopes between them. */
const SHARPNESS = 1.25;
/** Coarse jitter knots across the whole line (≈ half of them fall inside the bump). */
const KNOTS = 22;
/** Waveform samples between knots: far enough apart to be independent. */
const KNOT_STRIDE = 89;
/** Coarse jitter depth: knot factors range from 1 − JITTER to 1 + 3·JITTER. */
const JITTER = 0.55;
/** Fine, per-point jaggedness inside the bump, relative to the local height. */
const JAG = 0.1;
/** Most bands the right half reads offset from the left. */
const SKEW = 4;
/** Waveform-driven wiggle everywhere (units of full peak height). */
const WIGGLE = 0.012;
/** Soft-ceiling strength: heights approach 1 / CEILING. */
const CEILING = 0.45;
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
    // Flat top, then a raised-cosine shoulder: the eruption fills the middle, not one spire.
    out[i] = d <= PLATEAU ? 1 : d < 1 ? 0.5 + 0.5 * Math.cos((Math.PI * (d - PLATEAU)) / (1 - PLATEAU)) : 0;
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
      // Linear between knots: corners make the sharp, triangular peaks of the original.
      const f = u - j;
      const k0 = wave[(j * KNOT_STRIDE + knotBase) % n] / wmax;
      const k1 = wave[((j + 1) * KNOT_STRIDE + knotBase) % n] / wmax;
      // Squared: most knots sit low and a few run tall, so each ridge has a few dominant peaks.
      const c = 0.5 + 0.5 * (k0 + (k1 - k0) * f);
      const m = 1 - JITTER + 4 * JITTER * c * c; // 1 when the waveform is silent (c = ½)
      // Tilt up the higher bands so the bass doesn't always win the middle.
      const g = gain * r * (1 - TILT + 2 * TILT * t);
      const v = Math.pow(g * (m > 0 ? m : 0), SHARPNESS);
      // Soft ceiling: the tallest peaks stop short of flying off the plot.
      y += v / (1 + CEILING * v) + JAG * g * (w / wmax);
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

const PAD_Y = 0.07;
const PAD_X = 0.06;
/** Plot width / height. */
const PLOT_ASPECT = 0.78;
/** Full peak height as a fraction of the plot height (at Height = 1). */
const AMP_FRAC = 0.15;
/** Room above the oldest baseline, as a fraction of the default full peak height. */
const HEADROOM = 0.7;

/**
 * Where the plot goes: centred, with margins, a portrait-ish width like the cover. Baselines run
 * from `top` (oldest line) to `bottom` (newest); `amp` is the full peak height in pixels.
 * @template {{ left: number, width: number, top: number, bottom: number, spacing: number, amp: number }} T
 * @param {number} w canvas width, pixels
 * @param {number} h canvas height, pixels
 * @param {number} lines
 * @param {number} height the Height param (1 = default)
 * @param {T} out
 * @returns {T}
 */
export function ridgeLayout(w, h, lines, height, out) {
  const padY = h * PAD_Y;
  const padX = w * PAD_X;
  const plotH = h - 2 * padY;
  out.width = Math.min(w - 2 * padX, plotH * PLOT_ASPECT);
  out.left = (w - out.width) / 2;
  out.bottom = h - padY;
  out.top = padY + plotH * AMP_FRAC * HEADROOM;
  out.spacing = (out.bottom - out.top) / Math.max(1, lines - 1);
  out.amp = plotH * AMP_FRAC * height;
  return out;
}

/**
 * Draw the history with hidden-line removal on a transparent canvas: back to front, each line
 * first erases what lies behind it (destination-out fill under its curve), then strokes itself.
 * @param {CanvasRenderingContext2D} g
 * @param {ReturnType<typeof createRing>} ring
 * @param {{ left: number, width: number, bottom: number, spacing: number, amp: number }} lay
 * @param {number} frac scroll fraction 0–1 from {@link advanceScroll}
 * @param {string} color stroke color
 * @param {number} lineWidth pixels
 */
export function drawRidges(g, ring, lay, frac, color, lineWidth) {
  const { data, points, lines } = ring;
  const { left, spacing, amp } = lay;
  const dx = lay.width / (points - 1);
  const right = left + lay.width;
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = "round";
  for (let age = lines - 1; age >= 0; age--) {
    const o = ringRow(ring, age);
    const base = lay.bottom - (age + frac) * spacing;
    // The oldest line fades out as it leaves, the newest fades in as it arrives: no popping.
    g.globalAlpha = age === lines - 1 ? 1 - frac : age === 0 ? frac : 1;

    tracePoints(g, data, o, points, left, dx, base, amp);
    const floor = base + spacing;
    g.lineTo(right, floor);
    g.lineTo(left, floor);
    g.closePath();
    g.globalCompositeOperation = "destination-out";
    g.fill();

    g.globalCompositeOperation = "source-over";
    tracePoints(g, data, o, points, left, dx, base, amp);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/**
 * Begin a path along one row's curve.
 * @param {CanvasRenderingContext2D} g
 * @param {Float32Array} data
 * @param {number} o row offset
 * @param {number} points
 * @param {number} left
 * @param {number} dx
 * @param {number} base baseline y
 * @param {number} amp
 */
function tracePoints(g, data, o, points, left, dx, base, amp) {
  g.beginPath();
  g.moveTo(left, base - data[o] * amp);
  for (let i = 1; i < points; i++) g.lineTo(left + i * dx, base - data[o + i] * amp);
}
