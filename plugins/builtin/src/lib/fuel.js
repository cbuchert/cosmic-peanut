// @ts-check
/**
 * Blaze's spectrum feed: pure, allocation-free per-frame helpers that turn the host's 64 bands into
 * the fire's fuel line (mirrored, bass at the centre), transient jets and a gated, expanded height
 * profile. GPU side: shaders/blaze/.
 */
import { createAutoGain, resampleSeed } from "./fire.js";

/**
 * Spread the bands across the fuel line, mirrored: band 0 (the lowest) at the centre, the highest
 * at both edges, linearly interpolated between bands so neighbouring bands blend into flame roots
 * rather than bars. Texel i sits at x = (i + 0.5) / out.length.
 * @param {ArrayLike<number>} bands
 * @param {Float32Array} out
 */
export function mapMirrored(bands, out) {
  const S = out.length;
  const last = bands.length - 1;
  const inv = S > 2 ? 1 / (S - 2) : 0;
  for (let i = 0; i < S; i++) {
    const d = Math.abs(2 * i + 1 - S) - 1; // 0 at the two centre texels … S − 2 at the edges
    const f = d * inv * last;
    const b0 = Math.floor(f);
    const b1 = b0 < last ? b0 + 1 : last;
    const a = bands[b0];
    out[i] = a + (bands[b1] - a) * (f - b0);
  }
}

/** Noise gate per unit of reactivity (normalised level, 0–1). */
const GATE = 0.12;
/** Extra expansion exponent per unit of reactivity (1 = linear). */
const EXPAND = 0.9;

/**
 * Gate and expand one normalised level (0–1): everything under the gate is cut, the rest is
 * rescaled to 0–1 and raised to a power > 1, so quiet bands smoulder low and only real peaks reach
 * the top. Reactivity 0 is linear and ungated; 2 is the most dramatic.
 * @param {number} n normalised level (clamped to 0–1)
 * @param {number} reactivity 0–2
 */
export function shapeLevel(n, reactivity) {
  const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
  const gate = GATE * r;
  const x = ((n < 1 ? n : 1) - gate) / (1 - gate);
  return x > 0 ? x ** (1 + EXPAND * r) : 0;
}

/**
 * Per-band slow auto-gain. Each band tracks its own peak (instant attack, slow release) and is
 * normalised against the geometric mean of that peak and the loudest band's, clamped to 0–1: a
 * quiet mix still reaches full height, a naturally quiet band (hats) gets some lift without being
 * flattened to the level of the bass, and the song's spectral shape survives. A floor keeps
 * silence and hiss out.
 * @param {number} count bands
 * @param {{ release?: number, floor?: number }} [opts] release in seconds
 */
export function createBandGain(count, { release = 4, floor = 0.05 } = {}) {
  const env = new Float32Array(count);
  return {
    /**
     * @param {ArrayLike<number>} bands
     * @param {number} dt seconds
     * @param {Float32Array} out normalised levels, 0–1
     */
    step(bands, dt, out) {
      const k = Math.exp(-dt / release);
      let top = 0;
      for (let i = 0; i < count; i++) {
        const v = bands[i];
        const e = env[i] * k;
        env[i] = v > e ? v : e;
        if (env[i] > top) top = env[i];
      }
      for (let i = 0; i < count; i++) {
        const ref = Math.sqrt(env[i] * top);
        const n = bands[i] / (ref > floor ? ref : floor);
        out[i] = n < 1 ? n : 1;
      }
    },
    reset() {
      env.fill(0);
    },
  };
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

/** Waveform flicker on the spectrum feed: ± this fraction of the fuel. */
const TEXTURE = 0.2;
/** Release of the shaped band levels (s): roots rise at once and fall over ~150 ms. */
const ROOT_RELEASE = 0.15;
/** The overall loudness reference for jet detection: slow attack and release (s), and a floor. */
const DETECT_ATTACK = 0.8;
const DETECT_RELEASE = 4;
const DETECT_FLOOR = 0.1;

/**
 * The fire's per-frame feed: fills `fuel` (fuel-line level per texel, ≥ 0) and `jet` (transient
 * jet strength per texel, 0–2) from one audio frame. Everything is preallocated here.
 * - "waveform": the original Blaze feed, the newest waveform resampled across the line (|w|) times
 *   a loudness auto-gain; no jets.
 * - "spectrum": the bands, auto-gained per band (createBandGain), gated and expanded
 *   (shapeLevel), held with a ~150 ms release so roots don't flicker frame to frame, mapped mirrored across the line (bass at the centre), times a ±TEXTURE flicker
 *   from the waveform under each texel. Jets come from createAttacks on the bands scaled by a
 *   slow overall loudness reference (so a kick after a quiet bar is a big rise, while the height
 *   normalisation reacts at once), mapped the same way.
 * @param {number} size fuel-line texels
 * @param {number} count host bands
 */
export function createFeed(size, count) {
  const fuel = new Float32Array(size);
  const jet = new Float32Array(size);
  const mag = new Float32Array(size);
  const signed = new Float32Array(size);
  const waveGain = createAutoGain();
  const bandGain = createBandGain(count);
  const attacks = createAttacks(count);
  const norm = new Float32Array(count);
  const det = new Float32Array(count);
  const jets = new Float32Array(count);
  const held = new Float32Array(count);
  let ref = 0;
  return {
    fuel,
    jet,
    /**
     * @param {{ bands: ArrayLike<number>, waveform: ArrayLike<number>, silent: boolean }} audio
     * @param {number} dt seconds
     * @param {string} feed "spectrum" | "waveform"
     * @param {number} reactivity 0–2
     * @param {boolean} reduceFlashing
     */
    step(audio, dt, feed, reactivity, reduceFlashing) {
      resampleSeed(audio.waveform, mag, signed);
      let peak = 0;
      for (let i = 0; i < size; i++) if (mag[i] > peak) peak = mag[i];
      const g = audio.silent ? 0 : waveGain.step(peak, dt);
      if (feed === "waveform") {
        for (let i = 0; i < size; i++) fuel[i] = mag[i] * g;
        jet.fill(0);
        return;
      }
      const bands = audio.bands;
      const r = reactivity > 0 ? (reactivity < 2 ? reactivity : 2) : 0;
      bandGain.step(bands, dt, norm);
      const keep = Math.exp(-dt / ROOT_RELEASE);
      let top = 0;
      for (let i = 0; i < count; i++) {
        const v = audio.silent ? 0 : bands[i];
        if (v > top) top = v;
        const shaped = audio.silent ? 0 : shapeLevel(norm[i], r);
        const fallen = held[i] * keep;
        held[i] = shaped > fallen ? shaped : fallen;
      }
      ref += (top - ref) * (1 - Math.exp(-dt / (top > ref ? DETECT_ATTACK : DETECT_RELEASE)));
      const inv = 1 / (ref > DETECT_FLOOR ? ref : DETECT_FLOOR);
      for (let i = 0; i < count; i++) det[i] = audio.silent ? 0 : bands[i] * inv;
      attacks.step(det, dt, r, reduceFlashing, jets);
      mapMirrored(held, fuel);
      mapMirrored(jets, jet);
      for (let i = 0; i < size; i++) {
        const w = mag[i] * g;
        fuel[i] *= 1 - TEXTURE + 2 * TEXTURE * (w < 1 ? w : 1);
      }
    },
  };
}
