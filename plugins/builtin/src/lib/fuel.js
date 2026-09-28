// @ts-check
/**
 * Blaze's spectrum feed: pure, allocation-free per-frame helpers that turn the host's 64 bands into
 * the fire's fuel line (mirrored, bass at the centre), transient jets and a gated, expanded height
 * profile. GPU side: shaders/blaze/.
 */

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
