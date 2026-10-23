// @ts-check
/**
 * Tiled Torus waves: the waveform deforms the torus. Each moment's waveform is laid round the
 * ring (θ) at the hole (the inner equator, φ = π) and rolls a full lap round the tube: over the
 * top, round the outer equator, back underneath and into the hole again, at full height all the
 * way. Where a lap closes, the waves finishing it cross-fade into the newborn ones over a short
 * stretch (BIRTH of a lap) just past the hole, so there is no step and no dip. A history of rings
 * (COLS samples round θ, one row per push, ROWS rows: a lap and that stretch) lives in an R16F
 * texture, one row uploaded per push.
 *
 * The ring building follows Cosmic Peanut's (lib/ring.js there; packs are served separately, so
 * the pattern is copied, not imported): a rising zero-crossing trigger so a steady tone keeps
 * its shape, point resampling, tracked-peak auto-gain. Three changes for a surface: the ring is
 * made seamless round θ by cross-fading the window's end into its start (no taper to zero), it
 * is rounded (no needles), and the shape is smoothed from row to row so neighbouring rows don't
 * form cliffs. The beat stamp (1 + STAMP × the eased beat envelope) and the bass are baked into
 * each row's height as it is pushed, so they roll round with it and nothing already on the
 * surface changes. shaders/tess/torus.frag mirrors `dispAt`. Nothing here allocates after
 * construction.
 */

/** Samples round the ring (θ); rows pushed per lap round the tube; the stretch past the hole
 * (fraction of a lap) where finishing waves hand over to newborn ones; history rows (a lap plus
 * that stretch, plus the two rows the interpolation reads). */
export const COLS = 128;
export const LAP_ROWS = 56;
export const BIRTH = 0.2;
export const ROWS = 72;
/** Normalized ring values are clamped to ± this before the gain… */
export const RING_CLAMP = 1.5;
/** …and stored values (after gain and stamp) to ± this. */
export const WAVE_CLAMP = 2.5;
/** Extra gain of a row laid down at the beat envelope's peak. */
export const STAMP = 1;
/** Every row's gain before the stamp: auto-gained rings are scaled up so ordinary music shows. */
export const BASE_GAIN = 1.35;
/** Fraction of the window cross-faded at the wrap so the ring closes round θ. */
export const LOOP = 0.15;
/** Each row's shape moves this far from the previous row's towards the new waveform. */
export const SHAPE_BLEND = 0.65;
/** The most a column may change from one row to the next (stored units): a beat stamp or a new
 * waveform builds over a few rows instead of a cliff, which keeps the march's steps long. */
export const ROW_SLEW = 0.6;
/** Auto-gain: per-push decay of the tracked peak, and its floor (silence stays flat). */
export const PEAK_DECAY = 0.992;
export const PEAK_FLOOR = 0.02;
/** World displacement per unit of stored value, per unit of Wave height and tube radius. */
const AMP_K = 0.45 / WAVE_CLAMP;

/** Samples one ring spans: 1024 at Detail 0 (smooth) down to 192 at Detail 1 (jagged). @param {number} detail 0–1 */
export const windowLength = (detail) => Math.round(1024 - 832 * Math.max(0, Math.min(1, detail)));

/**
 * Oscilloscope trigger: the first rising zero crossing that leaves `span` samples after it, so
 * consecutive rings line up; 0 if there is none.
 * @param {ArrayLike<number>} wave @param {number} span
 */
export function findTrigger(wave, span) {
  for (let i = 1; i + span < wave.length; i++) if (wave[i - 1] < 0 && wave[i] >= 0) return i;
  return 0;
}

/** @param {ArrayLike<number>} wave @param {number} x */
function sampleAt(wave, x) {
  const last = wave.length - 1;
  const i0 = Math.min(last, Math.max(0, Math.floor(x)));
  const i1 = i0 < last ? i0 + 1 : last;
  const f = Math.min(1, Math.max(0, x - i0));
  return wave[i0] * (1 - f) + wave[i1] * f;
}

/**
 * Point-sample a window of W samples from `start` into out.length points, closing it into a
 * loop: the first LOOP of the ring cross-fades from the samples just after the window into the
 * window's own, so the last point runs straight into the first. Needs start + W(1 + LOOP)
 * samples. Returns the absolute peak written.
 * @param {ArrayLike<number>} wave @param {number} start @param {number} W @param {Float32Array} out
 */
export function resampleLoop(wave, start, W, out) {
  const M = out.length;
  const step = W / M;
  const fadeN = Math.max(1, Math.round(M * LOOP));
  let peak = 0;
  for (let j = 0; j < M; j++) {
    const x = start + j * step;
    let v = sampleAt(wave, x);
    if (j < fadeN) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * j) / fadeN);
      v = v * w + sampleAt(wave, x + W) * (1 - w);
    }
    out[j] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * A row's gain: Reactivity × BASE_GAIN × (1 + STAMP × the eased beat envelope) × the bass's
 * share (0.7 + 0.3 × bassAtt, bassAtt clamped 0–2: 1 at average bass).
 * @param {number} env @param {number} reactivity @param {number} bassAtt
 */
export const rowGain = (env, reactivity, bassAtt) =>
  Math.max(0, reactivity) * BASE_GAIN * (1 + STAMP * env) * (0.7 + 0.3 * Math.max(0, Math.min(2, bassAtt)));

/** World displacement per stored unit. @param {number} height Wave height 0–1 @param {number} k tube radius */
export const waveAmp = (height, k) => Math.max(0, Math.min(1, height)) * k * AMP_K;
/** The largest displacement either way (≤ 0.45 k: the inside camera stays clear). @param {number} height @param {number} k */
export const maxDisp = (height, k) => waveAmp(height, k) * WAVE_CLAMP;

/**
 * Age of the surface at φ, in laps: 0 at the hole (φ = π), ¼ on top, ½ on the outer equator, ¾
 * underneath, → 1 back at the hole. @param {number} phi
 */
export const ageOf = (phi) => {
  const a = (Math.PI - phi) / (2 * Math.PI);
  return a - Math.floor(a);
};

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * @param {number} cols @param {number} rows
 * @param {(row: number, data: Float32Array) => void} upload called once per pushed row with its
 *   texels (a view into `data`, read it during the call)
 */
export function createWaveHistory(cols, rows, upload) {
  const ring = new Float32Array(cols);
  const tmp = new Float32Array(cols);
  const shape = new Float32Array(cols);
  let track = 0.1;
  const h = {
    cols,
    rows,
    /** Row of the newest ring. */
    head: 0,
    /** Leftover fraction of a push interval (rows glide between pushes). */
    frac: 0,
    /** cols × rows, row-major. */
    data: new Float32Array(cols * rows),
    /** Per row: the largest step between neighbouring samples (round the wrap too)… */
    slopeCol: new Float32Array(rows),
    /** …and the largest change from the row before. */
    slopeRow: new Float32Array(rows),
    /**
     * Push the rows due after dt (LAP_ROWS per travel time: one lap), each from the newest waveform.
     * @param {ArrayLike<number>} wave
     * @param {number} dt seconds
     * @param {{ travel: number, detail: number, env: number, bassAtt: number, reactivity: number }} o
     *   travel: seconds for a lap round the tube; env: the eased beat envelope
     * @returns {number} rows pushed
     */
    step(wave, dt, o) {
      const clock = h.frac + (dt * LAP_ROWS) / Math.max(0.1, o.travel);
      const n = Math.floor(clock);
      h.frac = clock - n;
      if (n === 0) return 0;
      // Build the ring once per frame; every row pushed this frame gets it.
      let W = windowLength(o.detail);
      const span = (/** @type {number} */ w) => Math.ceil(w * (1 + LOOP)) + 2;
      while (W > 16 && span(W) > wave.length) W = Math.floor(W / 2);
      const i = findTrigger(wave, span(W));
      const a = i > 0 ? wave[i - 1] : 0;
      const start = i > 0 ? i - 1 + a / (a - wave[i]) : 0;
      resampleLoop(wave, start, W, ring);
      const peak = smoothRing(ring, tmp);
      const gain = rowGain(o.env, o.reactivity, o.bassAtt);
      for (let k = 0; k < n; k++) {
        const decayed = track * PEAK_DECAY;
        track = peak > decayed ? peak : decayed;
        const norm = 1 / (track > PEAK_FLOOR ? track : PEAK_FLOOR);
        const prev = h.head;
        h.head = (h.head + 1) % rows;
        const base = h.head * cols;
        const pbase = prev * cols;
        let sc = 0;
        let sr = 0;
        for (let j = 0; j < cols; j++) {
          let v = ring[j] * norm;
          v = v > RING_CLAMP ? RING_CLAMP : v < -RING_CLAMP ? -RING_CLAMP : v;
          shape[j] += (v - shape[j]) * SHAPE_BLEND;
          let g = shape[j] * gain;
          g = g > WAVE_CLAMP ? WAVE_CLAMP : g < -WAVE_CLAMP ? -WAVE_CLAMP : g;
          const was = h.data[pbase + j];
          g = g > was + ROW_SLEW ? was + ROW_SLEW : g < was - ROW_SLEW ? was - ROW_SLEW : g;
          h.data[base + j] = g;
          const dr = Math.abs(g - h.data[pbase + j]);
          if (dr > sr) sr = dr;
        }
        for (let j = 0; j < cols; j++) {
          const d = Math.abs(h.data[base + ((j + 1) % cols)] - h.data[base + j]);
          if (d > sc) sc = d;
        }
        h.slopeCol[h.head] = sc;
        h.slopeRow[h.head] = sr;
        upload(h.head, h.data.subarray(base, base + cols));
      }
      return n;
    },
  };
  return h;
}

/** @param {ReturnType<typeof createWaveHistory>} h @param {number} r rows ago (≥ 0) @param {number} x column (fractional) */
function valueAt(h, r, x) {
  const rr = Math.min(h.rows - 2, Math.max(0, r));
  const r0 = Math.floor(rr);
  const tr = rr - r0;
  const j0 = Math.floor(x) % h.cols;
  const j1 = (j0 + 1) % h.cols;
  const t = x - Math.floor(x);
  const row = (/** @type {number} */ k) => ((((h.head - k) % h.rows) + h.rows) % h.rows) * h.cols;
  const a = row(r0);
  const b = row(r0 + 1);
  const va = h.data[a + j0] * (1 - t) + h.data[a + j1] * t;
  const vb = h.data[b + j0] * (1 - t) + h.data[b + j1] * t;
  return va * (1 - tr) + vb * tr;
}

/**
 * Displacement along the normal at (θ, φ) (mirrors torus.frag): column from θ (linear, wrapping),
 * rows ago from the age (LAP_ROWS a lap, gliding by `frac` between pushes), linear between two
 * rows. Just past the hole (age < BIRTH) the waves finishing their lap (a lap older, still in the
 * history) cross-fade into the newborn ones, so the lap closes without a step or a dip.
 * @param {ReturnType<typeof createWaveHistory>} h @param {number} theta @param {number} phi @param {number} amp
 */
export function dispAt(h, theta, phi, amp) {
  const u = theta / (2 * Math.PI);
  const x = (u - Math.floor(u)) * h.cols;
  const age = ageOf(phi);
  const r = age * LAP_ROWS - h.frac;
  let v = valueAt(h, r, x);
  if (age < BIRTH) v = valueAt(h, r + LAP_ROWS, x) + (v - valueAt(h, r + LAP_ROWS, x)) * smooth(age / BIRTH);
  return amp * v;
}

/**
 * The raymarch's step factor 1 / √(1 + G²): the displaced surface is f = sdTorus − disp(θ, φ),
 * and disp's gradient is tangent to the tube, so |∇f| ≤ √(1 + G²) with G a bound on |∇disp|
 * on the displaced shell (tube distance ≥ k − D, axis distance ≥ 1 − k − D, D = liveDisp: the
 * march only uses the factor inside that shell). G comes from the
 * history as it is now: the steepest step between columns (round θ) and between rows (across
 * φ, LAP_ROWS rows per 2π), plus the hand-over just past the hole (the largest difference
 * between a newborn row and the one a lap older that it replaces, over BIRTH of a lap,
 * smoothstep slope 1.5). Run once per frame, O(ROWS + BIRTH × LAP_ROWS × COLS).
 * @param {ReturnType<typeof createWaveHistory>} h @param {number} amp waveAmp @param {number} k tube radius
 */
export function stepFactor(h, amp, k) {
  let sc = 0;
  let sr = 0;
  let peak = 0; // largest hand-over difference
  for (let r = 0; r < h.rows; r++) {
    if (h.slopeCol[r] > sc) sc = h.slopeCol[r];
    if (h.slopeRow[r] > sr) sr = h.slopeRow[r];
  }
  // The hand-over: newborn rows (0 … BIRTH × LAP_ROWS + 2 ago) against the rows a lap older.
  const nb = Math.min(h.rows - 1 - LAP_ROWS, Math.ceil(BIRTH * LAP_ROWS) + 2);
  for (let r = 0; r <= nb; r++) {
    const a = ((((h.head - r) % h.rows) + h.rows) % h.rows) * h.cols;
    const b = ((((h.head - r - LAP_ROWS) % h.rows) + h.rows) % h.rows) * h.cols;
    for (let j = 0; j < h.cols; j++) {
      const d = Math.abs(h.data[a + j] - h.data[b + j]);
      if (d > peak) peak = d;
    }
  }
  if (amp <= 0 || (sc === 0 && sr === 0 && peak === 0)) return 1;
  const D = liveDisp(h, amp);
  const q = Math.max(1e-3, k - D);
  const rho = Math.max(1e-3, 1 - k - D);
  const gTheta = (amp * h.cols * sc) / (2 * Math.PI * rho);
  const gPhi = (amp * (LAP_ROWS * sr + (1.5 * peak) / BIRTH)) / (2 * Math.PI * q);
  return 1 / Math.sqrt(1 + gTheta * gTheta + gPhi * gPhi);
}

/**
 * Round a ring in place: two circular [1 2 1] / 4 passes (wrapping round θ, so the seam stays
 * closed). Slow shapes keep their form; sample-to-sample spikes, which would print as needles
 * and force tiny march steps, are flattened. Returns the absolute peak.
 * @param {Float32Array} ring @param {Float32Array} tmp same length
 */
export function smoothRing(ring, tmp) {
  const M = ring.length;
  let peak = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < M; j++) tmp[j] = ring[j];
    for (let j = 0; j < M; j++) {
      const v = 0.25 * tmp[(j + M - 1) % M] + 0.5 * tmp[j] + 0.25 * tmp[(j + 1) % M];
      ring[j] = v;
      if (pass === 1 && Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  return peak;
}

/**
 * The largest |displacement| the surface has now: amp × the largest stored value (dispAt only
 * interpolates and cross-fades stored values). The march's shell and bounding sphere use it, so
 * the shell is as thin as the music makes it; ≤ maxDisp. Once per frame, O(COLS × ROWS).
 * @param {ReturnType<typeof createWaveHistory>} h @param {number} amp
 */
export function liveDisp(h, amp) {
  let m = 0;
  for (let i = 0; i < h.data.length; i++) {
    const a = h.data[i] < 0 ? -h.data[i] : h.data[i];
    if (a > m) m = a;
  }
  return amp * m;
}
