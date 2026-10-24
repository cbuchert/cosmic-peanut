// @ts-check
/**
 * The tessellation family's Look param and the cinematic look's pure, tested pieces. The shaders
 * mirror them: shaders/tess/look.glsl (materials, horizon AO, the circle of confusion, the
 * atmosphere), shaders/tess/post.frag (the depth-of-field gather, the bloom prefilter, the tone
 * curve and the composite). lib/tess-gl.js compiles the cinematic programs and runs the post
 * passes. Nothing here allocates per frame.
 *
 * - classic: the woodcut print as it was, byte for byte: its programs' text carries no define,
 *   and every line of the cinematic code sits under `#ifdef TESS_CINEMATIC`.
 * - cinematic: the print as a carved, inked, printed object under a raking light — satin ink
 *   (GGX), rough paper with a wrap diffuse, bare end grain on the cut sides, horizon-based ambient
 *   occlusion in the grooves, depth of field on the 3D surfaces, paper-coloured atmosphere, a
 *   faint bloom on the brightest highlights and a film-like shoulder.
 *
 * Fixed constants, not params: none of them react to the beat (the music moves the block, never
 * the exposure, the bloom or the focus).
 */

/** Look options, in manifest order. */
export const LOOKS = ["classic", "cinematic"];
/** Manifest default of the Look param. */
export const DEFAULT_LOOK = "classic";

/** @param {unknown} name the Look param → "classic" | "cinematic" (unknown → DEFAULT_LOOK) */
export function lookOf(name) {
  return LOOKS.includes(String(name)) ? String(name) : DEFAULT_LOOK;
}

/**
 * Extra `#define`s for the cinematic programs. Classic adds none, so its programs' text is exactly
 * what it was. @param {unknown} name the Look param
 */
export function lookDefines(name) {
  return lookOf(name) === "cinematic" ? ["TESS_CINEMATIC"] : [];
}

/**
 * The tone curve's knee (post.frag TONE_KNEE), linear light. Every palette colour sits at or under
 * it (the brightest, watercolour's paper, is 0.922), so paper, ink and tiles print exactly as
 * their palette says; only light above it — a lit ridge, a glint — is compressed.
 */
export const TONE_KNEE = 0.93;

/**
 * The cinematic tone curve (post.frag `tone`, per channel): the identity up to TONE_KNEE, then an
 * exponential shoulder that approaches white with slope 1 at the knee (C¹), so highlights roll off
 * instead of clipping. A linear segment and a shoulder, after the piecewise filmic curves of John
 * Hable ("Filmic Tonemapping with Piecewise Power Curves", 2017), with no toe: a toe would move
 * the palettes' inks. Per channel, so the brightest highlights drift towards white, like film.
 * @param {number} x linear light → display linear, 0 ≤ y < 1
 */
export function tone(x) {
  if (!(x > 0)) return 0;
  if (x <= TONE_KNEE) return x;
  const w = 1 - TONE_KNEE;
  return TONE_KNEE + w * -Math.expm1(-(x - TONE_KNEE) / w);
}

/**
 * The composite's alpha. The SDK's canvas is premultiplied over the shell's backdrop; the other
 * families give light drawn on black alpha = its brightest channel and what a surface covers at
 * least its coverage (lib/lattice-look.js compositeAlpha). The tessellations are printed on paper
 * that covers every pixel (coverage 1), so the canvas stays opaque in both Looks, as classic is.
 * @param {number} r @param {number} g @param {number} b display colour
 */
export function compositeAlpha(r, g, b) {
  return Math.min(1, Math.max(1, r, g, b));
}

/** Bloom: only light above this blooms (linear; above every palette colour, so paper never does)… */
export const BLOOM_THRESHOLD = 1;
/** …eased in over ± this (a soft knee, so a highlight's bloom fades in without a step). */
export const BLOOM_KNEE = 0.06;
/** The bloom chain's share added back (post.frag u_bloomK): faint, a halation, not a glow. */
export const BLOOM_GAIN = 0.35;

/**
 * The bloom's prefilter (the first downsample, post.frag `prefilter`, per channel): the excess
 * over BLOOM_THRESHOLD with a quadratic soft knee (Karis, "Real Shading in Unreal Engine 4",
 * SIGGRAPH 2013 course notes, as used by UE4's bloom threshold): 0 below threshold − knee, the
 * excess above threshold + knee, a parabola between, continuous with a continuous slope.
 * @param {number} x linear light
 */
export function bloomPrefilter(x) {
  const t = BLOOM_THRESHOLD;
  const k = BLOOM_KNEE;
  if (x <= t - k) return 0;
  if (x >= t + k) return x - t;
  const s = x - t + k;
  return (s * s) / (4 * k);
}

/**
 * Signed circle of confusion (diameter, target px) at view depth z focused at `focus`: the thin
 * lens (Potmesil & Chakravarty, "A Lens and Aperture Camera Model for Synthetic Image Generation",
 * SIGGRAPH 1981: A·f/(z_f − f)·|z − z_f|/z, which for f ≪ z_f is A′·(1 − z_f/z)). Behind the focus
 * it is positive and tends to the aperture; in front it is negative (the gather lets near blur
 * spill over sharper pixels behind it), capped at −max. look.glsl tessCoC mirrors it.
 * @param {number} z view depth (> 0) @param {number} focus focal distance
 * @param {number} aperture blur far away, px (0: no depth of field) @param {number} max cap, px
 */
export function circleOfConfusion(z, focus, aperture, max) {
  if (aperture <= 0) return 0;
  const c = aperture * (1 - focus / Math.max(z, 1e-6));
  return c < -max ? -max : c > max ? max : c;
}

/** The focus spring's rate (1/s): critically damped, settled (99 %) in about 2.7 s. */
export const FOCUS_RATE = 2.5;

/**
 * The focus distance, eased towards the camera's subject with a critically damped spring (no
 * jumps, no overshoot; exact for any dt). Reduce motion holds it: no focus pulling.
 * @param {number} start
 */
export function createFocus(start) {
  let v = 0;
  const focus = {
    distance: start,
    /** @param {number} target @param {number} dt seconds @param {boolean} hold Reduce motion: stay put */
    step(target, dt, hold) {
      if (hold) {
        v = 0;
        return focus.distance;
      }
      const x = focus.distance - target;
      const b = v + FOCUS_RATE * x;
      const e = Math.exp(-FOCUS_RATE * dt);
      focus.distance = target + (x + b * dt) * e;
      v = (b - FOCUS_RATE * (x + b * dt)) * e;
      return focus.distance;
    },
    /** Jump to `d`, at rest (the first cinematic frame: nothing to pull from). @param {number} d */
    reset(d) {
      focus.distance = d;
      v = 0;
    },
  };
  return focus;
}

/**
 * Loop caps in the shaders (look.glsl AO_DIRS_MAX, AO_STEPS_MAX; post.frag DOF_TAPS_MAX; the
 * surfaces' shadow loops run to 8).
 */
export const SAMPLE_CAPS = Object.freeze({ aoDirs: 8, aoSteps: 4, dofTaps: 32, shadow: 8 });

/**
 * Per Quality: horizon-AO directions and steps per direction, depth-of-field gather taps, and
 * soft-shadow steps at most. The knobs for a performance pass: each surface's default Quality
 * holds 60 fps at 1440p (high, except Tiled Torus at medium), medium and low trade samples for time.
 */
const SAMPLES = {
  low: Object.freeze({ aoDirs: 2, aoSteps: 2, dofTaps: 6, shadow: 4 }),
  medium: Object.freeze({ aoDirs: 3, aoSteps: 2, dofTaps: 10, shadow: 6 }),
  high: Object.freeze({ aoDirs: 4, aoSteps: 2, dofTaps: 16, shadow: 8 }),
};
/** @param {unknown} quality the Quality param (unknown → high, the tess default) */
export function lookSamples(quality) {
  const q = String(quality);
  return q === "low" || q === "medium" ? SAMPLES[q] : SAMPLES.high;
}

/**
 * The focus subject inside or before a unit sphere at the origin: the distance along the unit view
 * direction f from the eye e to the sphere's wall straight ahead (inside: the far hit; outside:
 * the near hit), or, outside, the sphere centre's depth when the view misses it.
 * @param {number} ex @param {number} ey @param {number} ez @param {number} fx @param {number} fy @param {number} fz
 */
export function sphereWallAhead(ex, ey, ez, fx, fy, fz) {
  const b = ex * fx + ey * fy + ez * fz;
  const c = ex * ex + ey * ey + ez * ez - 1;
  const d = b * b - c;
  if (c < 0) return -b + Math.sqrt(d);
  if (d < 0 || -b - Math.sqrt(d) < 0) return Math.max(0, -b);
  return -b - Math.sqrt(d);
}

/**
 * The focus subject inside a torus (ring radius 1, tube radius k), flying along its centre
 * circle: the distance straight ahead along the circle's tangent to the tube's outer wall, where
 * the walls ahead meet the middle of the view. @param {number} k
 */
export function tubeWallAhead(k) {
  return Math.sqrt((1 + k) * (1 + k) - 1);
}
