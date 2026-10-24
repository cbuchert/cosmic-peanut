// @ts-check
/**
 * The Poincaré Disk carved like a woodblock: the engine's relief (lib/tess.js reliefProfile,
 * tess.glsl TESS_RELIEF) on the hyperbolic kites. disk.glsl diskRelief mirrors kiteHeight; this
 * module holds the constants, the bounds the shaders march between, the onset pops' rings and the
 * Light param, and is tested.
 *
 * Scale. The engine's heights are plane units of a tile half a unit across. A kite's size on the
 * face shrinks towards the rim as √A (1 − |w|²) (the disk's metric; A the kite's hyperbolic area),
 * so every height here is in tile units times that scale: the kites are carved alike in the
 * hyperbolic plane, and the rim's kites carve to nothing (they also fade out where the height map
 * can't resolve them, kiteFade). Resting tops lie on the face plane, the outline's groove is cut
 * below it, and the music lifts whole kites above it.
 *
 * Music (the sphere scene). The disk's own beat ripple (the latest beat's, and the one before it
 * running out, so a ripple is never cut short when the next beat lands) and spectrum heave, which used to swell the
 * face smoothly, now lift whole kites: the ripple by each kite's hyperbolic distance from the
 * beat's impact (tracked through the view's rebases), the heave ring by ring from the face's
 * centre, ± LIFT_VARY per kite (a hash of its quotient id); onsets pop single kites near the
 * ripple's front. Relief blends from the smooth swell (0, the print before relief) to the kites
 * (RELIEF_MIX and up). The flat scene takes the engine's own waves and pops by ring instead.
 */
import { RIPPLE_REACH, RIPPLE_SPEED, rippleLift, specLift } from "./disk3d.js";
import { FALL, LIGHT_DEFAULT, LIFT_VARY, RISE } from "./tess-music.js";
import { CARD_HALF, CARD_RISE, cardHeight, RELIEF_BLOCK } from "./tess.js";

/** Peak lift of a kite at the ripple's crest, tile units per unit of Reactivity (a kite is 0.5). */
export const KITE_BEAT = 0.5;
/** The kites' ripple fades with hyperbolic distance from the impact over this (the smooth swell's
 * is RIPPLE_REACH): the wave of lifting kites crosses much of the face. */
export const KITE_REACH = 2.2;
/** A kite's heave at a full band, tile units per unit of Reactivity. */
export const KITE_HEAVE = 0.16;
/** Onset pops on the face: the engine's pop heights × this (tile units). */
export const POP_BOOST = 1.5;
/** A pop lifts the chosen kites within this hyperbolic distance of its ring. */
export const POP_RING_BAND = 0.35;
/** Relief at and above which the music lifts whole kites (below it, part smooth swell). */
export const RELIEF_MIX = 0.25;
/** The carving fades in between these many height texels per half kite. */
export const KITE_FADE_LO = 3;
export const KITE_FADE_HI = 8;

/** @param {number} x */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** A kite's size (world units per tile unit) at radius r of the face. @param {number} kiteA √A @param {number} r */
export const kiteScale = (kiteA, r) => kiteA * Math.max(0, 1 - r * r);

/** How much of the carving a kite of this scale keeps in a height map of this texel (w units). @param {number} scale @param {number} texel */
export const kiteFade = (scale, texel) => smooth((0.5 * scale / texel - KITE_FADE_LO) / (KITE_FADE_HI - KITE_FADE_LO));

/** Relief → the share of the music's lift carried by whole kites (the rest is the smooth swell). @param {number} relief */
export const reliefMix = (relief) => smooth(relief / RELIEF_MIX);

/**
 * @typedef {object} KitePoint one point of a kite
 * @property {number} relief 0–1 @property {number} prof reliefProfile of the tile distance
 * @property {number} theta the card's turn 0–π @property {number} x card coordinate (tile units)
 * @property {number} hop the card's extra rise @property {number} lift the kite's (tile units)
 * @property {number} sPx @property {number} kPx kiteScale and kiteFade at the point
 * @property {number} sTile @property {number} kTile …and at the kite's centre (the whole kite lifts)
 */

/**
 * Height above the face plane (world units; disk.glsl diskRelief): the groove cut down from a
 * resting top, the block flattening as a card turns edge-on, plus the kite's lift and its card.
 * @param {KitePoint} k
 */
export function kiteHeight(k) {
  const ac = Math.abs(Math.cos(k.theta));
  const carve = k.relief * RELIEF_BLOCK * k.sPx * k.kPx * (ac * k.prof - 1);
  return carve + k.sTile * k.kTile * (Math.max(0, k.lift) + cardHeight(k.x, k.theta, k.hop));
}

/**
 * The heights kiteHeight (plus a smooth swell up to `smooth`) stays between: where the face's
 * relief march starts and ends, and the height map's range.
 * @param {{ relief: number, kiteA: number, lift: number, flipping: boolean, hop: number, smooth: number }} o
 *   lift: the largest kite lift now (tile units, its variation included)
 */
export function kiteBound(o) {
  const card = o.flipping ? CARD_RISE * (2 * CARD_HALF + o.hop) : 0;
  return { lo: -o.relief * RELIEF_BLOCK * o.kiteA, hi: o.kiteA * (Math.max(0, o.lift) + card) + Math.max(0, o.smooth) };
}

/**
 * The most the beat's ripple lifts anything now, over all distances: rippleLift is the envelope
 * (≤ 1) times e^(−d/REACH), and only tiles the front reached within the envelope's span still
 * move. @param {number} age s since the beat @param {number} period beat length (s) @param {number} [reach]
 */
export function rippleMax(age, period, reach = RIPPLE_REACH) {
  if (age <= 0) return 0;
  const fall = Math.max(0.05, FALL * period - RISE);
  const dMin = RIPPLE_SPEED * (age - RISE - fall);
  return Math.exp(-Math.max(0, dMin) / reach);
}

/**
 * @typedef {object} KiteMusic a kite's music (sphere scene; disk3d.frag kiteLift)
 * @property {number} age @property {number} period the ripple's (createKicks age, beat length)
 * @property {number} agePrev @property {number} dPrev the previous beat's ripple: its age, the kite's distance from its impact
 * @property {number} dImpact @property {number} dCentre the kite's hyperbolic distance from the impact and the centre
 * @property {number} vary 1 ± LIFT_VARY @property {number} beat @property {number} heave gains (tile units)
 * @property {number} ringR the face's ring radius @property {ArrayLike<number>} bands 16
 * @property {ArrayLike<number>} pops createKitePops().pops @property {number} hit 1 if the pops choose this kite
 */

/** A kite's lift (tile units). @param {KiteMusic} o */
export function kiteLift(o) {
  const ripple = rippleLift(o.age, o.dImpact, o.period, KITE_REACH) + rippleLift(o.agePrev, o.dPrev, o.period, KITE_REACH);
  let h = o.beat * ripple * o.vary + o.heave * specLift(o.bands, o.dCentre, o.ringR);
  for (let k = 0; k < 3; k++) {
    const p = o.pops[4 * k];
    if (p > 0 && o.hit > 0 && Math.abs(o.dImpact - o.pops[4 * k + 1]) < POP_RING_BAND) h += p;
  }
  return h;
}

/**
 * Upper bound of kiteLift over the face now.
 * @param {number} age @param {number} agePrev the ripples' ages @param {number} period
 * @param {number} beat @param {number} heave @param {ArrayLike<number>} bands 16 @param {ArrayLike<number>} pops
 */
export function sphereLiftMax(age, agePrev, period, beat, heave, bands, pops) {
  let band = 0;
  for (let i = 0; i < 16; i++) band = Math.max(band, bands[i]);
  let pop = 0;
  for (let k = 0; k < 3; k++) pop += Math.max(0, pops[4 * k]);
  return Math.max(0, beat) * (1 + LIFT_VARY) * (rippleMax(age, period, KITE_REACH) + rippleMax(agePrev, period, KITE_REACH)) + Math.max(0, heave) * band + pop;
}

/**
 * Onset pops for the face: the engine's pops (tess state `pops`: height, ring, seed per slot), each
 * placed, when it starts, on the ring the beat's ripple has reached (hyperbolic distance from the
 * impact), or scattered over the inner rings with no ripple in flight. `pops` (u_kPop): height
 * (tile units), ring, seed, 0. Allocation-free.
 */
export function createKitePops() {
  const prev = new Float32Array(3);
  const ring = new Float32Array(3);
  const p = {
    pops: new Float32Array(12),
    /**
     * @param {ArrayLike<number>} s the tess state's pops @param {number} front the ripple's front
     * (hyperbolic distance from the impact), −1 if none @param {number} boost height scale
     */
    step(s, front, boost) {
      for (let k = 0; k < 3; k++) {
        const h = s[4 * k];
        if (h > 0 && !(prev[k] > 0)) {
          const f = (s[4 * k + 2] * 0.6180339887) % 1;
          ring[k] = front >= 0 ? front : 0.3 + 1.2 * f;
        }
        prev[k] = h;
        p.pops[4 * k] = h * boost;
        p.pops[4 * k + 1] = ring[k];
        p.pops[4 * k + 2] = s[4 * k + 2];
        p.pops[4 * k + 3] = 0;
      }
      return p;
    },
  };
  return p;
}

/**
 * The sphere scene's key light for the Light param: the scene's light turned round its up axis
 * (y) by the param's offset from LIGHT_DEFAULT, so the default is the light as it always was.
 * @param {number} deg @param {ArrayLike<number>} base unit, world @param {Float64Array | Float32Array | number[]} out
 */
export function keyLight(deg, base, out) {
  const a = ((Number(deg) - LIGHT_DEFAULT) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = base[0] * c + base[2] * s;
  out[1] = base[1];
  out[2] = base[2] * c - base[0] * s;
  return out;
}
