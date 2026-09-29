// @ts-check
/** Tie-Dye's pure logic. */

/** Most colors a palette may have (uniform array sizes in the shader). */
export const MAX_COLORS = 8;
/** Seconds for the band widths to follow the mix. */
const WIDTH_TAU = 0.35;
/** Extra width per unit of region energy (a silent region keeps width 1). */
const WIDTH_GAIN = 3;

export function createBandWidths() {
  const w = new Float32Array(MAX_COLORS);
  const energy = new Float32Array(MAX_COLORS);
  return {
    /**
     * @param {Float32Array} bands
     * @param {number} n
     * @param {number} dt
     * @param {number} reactivity
     */
    step(bands, n, dt, reactivity) {
      w.fill(0);
      const a = 1 - Math.exp(-dt / WIDTH_TAU);
      let total = 0;
      for (let k = 0; k < n; k++) {
        const lo = Math.floor((k * bands.length) / n);
        const hi = Math.floor(((k + 1) * bands.length) / n);
        let e = 0;
        for (let i = lo; i < hi; i++) e += bands[i];
        energy[k] += (e / Math.max(1, hi - lo) - energy[k]) * a;
        w[k] = 1 + WIDTH_GAIN * reactivity * energy[k];
        total += w[k];
      }
      for (let k = 0; k < n; k++) w[k] /= total;
      return w;
    },
  };
}

/**
 * @typedef {object} SpinInput
 * @property {number} twist the Twist param (turns of spiral across the radius)
 * @property {number} speed the Speed param (motion multiplier)
 * @property {number} bassAtt `audio.bassAtt`
 * @property {number} reactivity the Reactivity param
 * @property {boolean} reduceMotion `ctx.reduceMotion`
 */

/** Manifest default of the Speed param. */
export const DEFAULT_SPEED = 1;
/** What Reduce motion uses instead of the default Speed, and how much slower the twist then follows. */
export const REDUCED_SPEED = 0.4;
const REDUCED_TWIST_SLOWDOWN = 3;
/** Rotation (turns/s at Speed 1): a slow drift plus a bass-driven part. */
const BASE_RATE = 0.02;
const BASS_RATE = 0.025;
/** Most the bass can tighten (or loosen) the twist, as a fraction of the Twist param. */
export const TWIST_DEPTH = 0.35;
/** Smoothing time constants (s): the twist runs through two such stages, the rate one. */
const TWIST_TAU = 0.4;
const RATE_TAU = 0.5;

/**
 * Spiral twist and rotation from the bass. Heavier bass (bassAtt > 1) tightens the twist and
 * speeds the rotation. The twist follows its target through two one-pole stages (so its rate of
 * change is continuous too) and the rate through one, so neither jerks.
 */
export function createSpin() {
  let rate = NaN;
  let twistMid = NaN;
  const s = {
    /** Current twist, turns across the unit radius. */
    twist: NaN,
    /** Unwrapped rotation, turns. */
    turns: 0,
    /** @param {number} dt @param {SpinInput} o */
    step(dt, o) {
      // Reduce motion: gentler defaults; a Speed the user picked is respected.
      const gentle = o.reduceMotion && o.speed === DEFAULT_SPEED;
      const speed = gentle ? REDUCED_SPEED : o.speed;
      const bass = Math.max(-1, Math.min(1, o.bassAtt - 1));
      const react = Math.max(0, Math.min(2, o.reactivity)) / 2;
      const twist = o.twist * (1 + TWIST_DEPTH * react * bass);
      const target = speed * (BASE_RATE + BASS_RATE * react * (1 + bass));
      if (Number.isNaN(s.twist)) {
        s.twist = twistMid = twist;
        rate = target;
      }
      const kt = 1 - Math.exp(-dt / (gentle ? TWIST_TAU * REDUCED_TWIST_SLOWDOWN : TWIST_TAU));
      twistMid += (twist - twistMid) * kt;
      s.twist += (twistMid - s.twist) * kt;
      rate += (target - rate) * (1 - Math.exp(-dt / RATE_TAU));
      s.turns += rate * dt;
      return s;
    },
  };
  return s;
}
