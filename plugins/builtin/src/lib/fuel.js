// @ts-check
/**
 * Blaze's feed: pure, allocation-free per-frame logic that turns one audio frame into the fire's
 * fuel line — fuel, transient jets and a per-column flame speed. The spectrogram maths lives in
 * spectro.js; the GPU side in shaders/blaze/.
 */
import { createAutoGain, resampleSeed } from "./fire.js";
import { createSpectroGain, logColumns, resampleSpectrum, riseSpeed } from "./spectro.js";

export const FEEDS = ["spectrogram", "waveform"];

/**
 * The feed to run for a saved/live param value: "waveform" stays, anything else — including the
 * retired 64-band "spectrum" feed a saved preset may still hold — runs the spectrogram.
 * @param {unknown} value
 */
export function resolveFeed(value) {
  return value === "waveform" ? "waveform" : "spectrogram";
}

/** Attack detection time constants and thresholds (seconds; normalised level units). */
const ATTACK = {
  fast: 0.015, // follows the band closely
  slow: 0.2, // the band's recent level
  average: 1.5, // the band's recent attack activity
  decay: 0.1, // jet envelope: ~5 % left after 300 ms
  minFlux: 0.06, // rises smaller than this are noise
  relative: 1.8, // … or less than this × the band's recent average
  full: 0.3, // a rise this big throws a full-strength jet
  retrigger: 0.08, // at most ~12 jets/s per band
  retriggerReduced: 1 / 3, // with reduceFlashing, at most 3 per second
};

/**
 * Per-band transient detector for the fire's jets. A band's attack is the positive gap between a
 * fast and a slow follower of its (normalised) level, so a rising step registers and a steady
 * tone doesn't. An attack well above the band's recent average (and above an absolute noise
 * floor) throws a jet: strength ∝ the rise, clamped to 1, growing while the rise grows, then decaying
 * over ~300 ms. A new jet can start at most every `retrigger` s per band (3 per second with
 * reduceFlashing, like the flash limiter). Output = jet × reactivity (so 0–2). All followers are
 * exact per `dt`, so 60 and 120 Hz agree.
 * @param {number} count bands
 */
export function createAttacks(count) {
  const fast = new Float32Array(count);
  const slow = new Float32Array(count);
  const avg = new Float32Array(count);
  const jet = new Float32Array(count);
  const since = new Float32Array(count).fill(1e9);
  const active = new Uint8Array(count);
  const last = new Float32Array(count);
  return {
    /**
     * @param {ArrayLike<number>} levels normalised band levels, 0–1
     * @param {number} dt seconds
     * @param {number} reactivity 0–2, scales the output
     * @param {boolean} reduceFlashing
     * @param {Float32Array} out jet strength per band, 0–reactivity
     */
    step(levels, dt, reactivity, reduceFlashing, out) {
      const kf = 1 - Math.exp(-dt / ATTACK.fast);
      const ks = 1 - Math.exp(-dt / ATTACK.slow);
      const ka = 1 - Math.exp(-dt / ATTACK.average);
      const kd = Math.exp(-dt / ATTACK.decay);
      const gap = reduceFlashing ? ATTACK.retriggerReduced : ATTACK.retrigger;
      const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      for (let i = 0; i < count; i++) {
        const v = levels[i];
        fast[i] += (v - fast[i]) * kf;
        slow[i] += (v - slow[i]) * ks;
        const d = fast[i] - slow[i];
        const flux = d > 0 ? d : 0;
        const thr = ATTACK.relative * avg[i];
        avg[i] += (flux - avg[i]) * ka;
        since[i] += dt;
        let j = jet[i] * kd;
        if (flux > ATTACK.minFlux && flux > thr) {
          if (!active[i] && since[i] >= gap) {
            active[i] = 1;
            since[i] = 0;
          }
          if (active[i] && flux > last[i]) {
            const s = flux / ATTACK.full;
            const strength = s < 1 ? s : 1;
            if (strength > j) j = strength;
          }
        } else active[i] = 0;
        last[i] = flux;
        jet[i] = j;
        out[i] = j * r;
      }
    },
    reset() {
      fast.fill(0);
      slow.fill(0);
      avg.fill(0);
      jet.fill(0);
      since.fill(1e9);
      active.fill(0);
      last.fill(0);
    },
  };
}

/** Frequency span of the spectrogram fuel line, Hz (the host bands' span). */
export const F_MIN = 30;
export const F_MAX = 16000;
/** Transient-jet groups across the distinct frequency columns. */
const GROUPS = 32;
/** Release of the column levels (s): roots rise at once and fall over ~150 ms. */
const ROOT_RELEASE = 0.15;

/**
 * The fire's per-frame feed. Fills, per fuel-line texel:
 * - `fuel` (≥ 0): the bed's heat;
 * - `jet` (0–2): transient jet strength;
 * - `rise` (screen heights per sim second): the upward speed the sim drives that column's gas to,
 *   0 = no level-driven lift (the waveform feed).
 * Feeds:
 * - "spectrogram" (default): audio.spectrum on a log-frequency axis F_MIN–F_MAX (logColumns;
 *   "mirrored" puts the bass at the centre and the highs at both edges, "linear" runs low → high
 *   left → right), max-resampled per column (resampleSpectrum), turned into 0–1 levels in dB with
 *   a gate and a slow per-frequency auto-gain (createSpectroGain), held with a ~150 ms release.
 *   fuel = level, rise = riseSpeed(level, reactivity): loud frequencies race up, quiet ones
 *   smoulder. Jets come from createAttacks on GROUPS log-frequency groups (loudest column of
 *   each), spread back across their columns.
 * - "waveform": the original Blaze feed, the newest waveform resampled across the line (|w|) times
 *   a loudness auto-gain; no jets, no rise.
 * Everything is preallocated here; `step` allocates nothing.
 * @param {number} size fuel-line texels (even)
 */
export function createFeed(size) {
  const fuel = new Float32Array(size);
  const jet = new Float32Array(size);
  const rise = new Float32Array(size);
  const mag = new Float32Array(size);
  const signed = new Float32Array(size);
  const waveGain = createAutoGain();
  const lo = new Float32Array(size);
  const hi = new Float32Array(size);
  const cols = new Float32Array(size);
  const level = new Float32Array(size);
  const held = new Float32Array(size);
  const group = new Uint8Array(size); // jet group per texel
  const gpos = new Float32Array(size); // fractional group position, for spreading jets back
  const grp = new Float32Array(GROUPS);
  const jets = new Float32Array(GROUPS);
  const gain = createSpectroGain(size);
  const attacks = createAttacks(GROUPS);
  let layout = "";

  /** @param {string} next */
  function setLayout(next) {
    layout = next === "linear" ? "linear" : "mirrored";
    logColumns(layout, F_MIN, F_MAX, lo, hi);
    const lnRange = Math.log(F_MAX / F_MIN);
    for (let i = 0; i < size; i++) {
      const u = Math.log(Math.sqrt(lo[i] * hi[i]) / F_MIN) / lnRange; // 0–1 up the log axis
      const g = Math.floor(u * GROUPS);
      group[i] = g < GROUPS - 1 ? g : GROUPS - 1;
      gpos[i] = u * GROUPS - 0.5;
    }
    gain.setTilt(lo, hi);
    gain.reset();
    attacks.reset();
    held.fill(0);
  }

  return {
    fuel,
    jet,
    rise,
    /**
     * @param {{ spectrum: ArrayLike<number>, waveform: ArrayLike<number>, sampleRate: number, silent: boolean }} audio
     * @param {number} dt seconds
     * @param {unknown} feed param value (resolveFeed)
     * @param {unknown} lay "mirrored" | "linear" (anything else is mirrored)
     * @param {number} reactivity 0–2
     * @param {boolean} reduceFlashing
     */
    step(audio, dt, feed, lay, reactivity, reduceFlashing) {
      if (resolveFeed(feed) === "waveform") {
        resampleSeed(audio.waveform, mag, signed);
        let peak = 0;
        for (let i = 0; i < size; i++) if (mag[i] > peak) peak = mag[i];
        const g = audio.silent ? 0 : waveGain.step(peak, dt);
        for (let i = 0; i < size; i++) fuel[i] = mag[i] * g;
        jet.fill(0);
        rise.fill(0);
        return;
      }
      const want = lay === "linear" ? "linear" : "mirrored";
      if (want !== layout) setLayout(want);
      const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      if (audio.silent) cols.fill(0);
      else resampleSpectrum(audio.spectrum, audio.sampleRate, lo, hi, cols);
      gain.step(cols, dt, level);
      const keep = Math.exp(-dt / ROOT_RELEASE);
      grp.fill(0);
      for (let i = 0; i < size; i++) {
        const v = level[i];
        const fallen = held[i] * keep;
        const h = v > fallen ? v : fallen;
        held[i] = h;
        fuel[i] = h;
        rise[i] = riseSpeed(h, r);
        const g = group[i];
        if (v > grp[g]) grp[g] = v;
      }
      attacks.step(grp, dt, r, reduceFlashing, jets);
      for (let i = 0; i < size; i++) {
        const x = gpos[i];
        const g0 = x > 0 ? Math.floor(x) : 0;
        const g1 = g0 < GROUPS - 1 ? g0 + 1 : GROUPS - 1;
        const f = x > g0 ? x - g0 : 0;
        jet[i] = jets[g0] + (jets[g1] - jets[g0]) * (f < 1 ? f : 1);
      }
    },
  };
}
