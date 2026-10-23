// @ts-check
/**
 * The music side of the tessellation visualizers (the tiling itself is lib/tess.js): beat
 * envelope, morph scheduler, glide, figure/ground inversion, spectrum rings, and the param
 * mapping they share. Every `step` allocates nothing. All audio effects are scaled by the
 * Reactivity param (0–2, 1 = default, 2 = strong).
 */
import { classColor, createWarp, groupOf, MAX_TILE_COLORS, paletteOf } from "./tess.js";

/** Without a confident tempo, onsets at least this strong count as beats. */
export const BEAT_STRENGTH = 0.6;
/** Seconds after an onset beat before another can count (fast fills don't machine-gun). */
export const REFRACTORY = 0.2;
/** With a confident tempo, an onset's kick is scaled by this: the beat leads, onsets only accent. */
export const ONSET_ACCENT = 0.2;
/** Seconds the envelope takes to ease up to its peak. */
export const RISE = 0.08;
/** The envelope is back to 0 this many beats after the beat (rise included). */
export const FALL = 0.9;
/** Beat length (s) assumed without a tempo (120 BPM). */
export const FALLBACK_PERIOD = 0.5;

/** @param {number} x */
export const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * @typedef {object} BeatInput
 * @property {number} bpm `audio.bpm` (0 until confident)
 * @property {number} beatPhase `audio.beatPhase`
 * @property {boolean} onset `audio.onset`
 * @property {number} onsetStrength `audio.onsetStrength`
 */

/**
 * The beat envelope, as in the Möbius visualizer's (packs are served separately, so the pattern
 * is copied, not imported): locked to the tempo when it's confident (a beat on each `beatPhase`
 * wrap; onsets only accent), from strong onsets otherwise. Each beat eases the envelope up with a
 * smoothstep over RISE seconds, then back to 0 with another over the rest of FALL beats: zero
 * slope at every join, so nothing clicks. A beat that lands mid-envelope rises from where it is.
 */
export function createBeat() {
  let phase = 0;
  let since = Infinity;
  let t = Infinity;
  let fall = 1;
  let from = 0;
  let level = 0;
  const b = {
    /** The envelope, 0–1. */
    env: 0,
    /** Beats so far. */
    count: 0,
    /** True on the frame of a beat. */
    beat: false,
    /** True when the beat came from the tempo (not an onset). */
    tempo: false,
    /** Seconds per beat (the tempo's, else FALLBACK_PERIOD). */
    period: FALLBACK_PERIOD,
    /** @param {BeatInput} a @param {number} dt */
    step(a, dt) {
      const tempo = a.bpm > 0;
      since += dt;
      t += dt;
      const strength = clamp(a.onsetStrength, 0, 1);
      if (tempo) {
        b.beat = a.beatPhase < phase - 0.5;
        phase = a.beatPhase;
      } else {
        b.beat = a.onset && strength >= BEAT_STRENGTH && since >= REFRACTORY;
        phase = 0;
      }
      b.tempo = tempo;
      b.period = tempo ? 60 / a.bpm : FALLBACK_PERIOD;
      let next = -1;
      if (b.beat) {
        b.count++;
        since = 0;
        next = tempo ? 1 : strength;
      } else if (tempo && a.onset && ONSET_ACCENT * strength > b.env) {
        next = ONSET_ACCENT * strength;
      }
      if (next >= 0) {
        from = b.env;
        level = next;
        t = 0;
        fall = Math.max(0.05, FALL * b.period - RISE);
      }
      b.env = t < RISE ? from + (level - from) * smooth(t / RISE) : level * (1 - smooth((t - RISE) / fall));
      return b;
    },
  };
  return b;
}

/** Tempo beats per morph step (a bar of 4/4). */
export const STEP_BEATS = 4;
/** Each morph eases over this many beats… */
export const EASE_BEATS = 1.5;
/** …and at least this many seconds. */
export const MIN_EASE = 0.6;
/** Reduce motion: steps this many times as far apart, eases this many times as long. */
export const REDUCED_STEP = 2;
export const REDUCED_EASE = 4;
/** Without a tempo, an onset this strong steps the morph… */
export const STEP_STRENGTH = 0.75;
/** …if the last step is at least this many seconds ago. */
export const MIN_STEP_GAP = 2;
/** Spectral centroid (fraction of Nyquist) mapped across the families, dark to bright. */
export const CENTROID_LO = 0.05;
export const CENTROID_HI = 0.3;
const CENTROID_TAU = 0.8;
/** Most the field turns (rad) between steps at Morph 1: it alternates −, 0, + . */
export const THETA_SWAY = 0.35;
/** The family the shapes start in (lib/tess.js FAMILIES: lobed, finned, star, hooked). */
export const START_FAMILY = 3;
const NF = 4;

/** Which family a centroid heads for: 0 (lobed, dark) … 3 (hooked, bright). @param {number} c */
export function centroidFamily(c) {
  const t = (c - CENTROID_LO) / (CENTROID_HI - CENTROID_LO);
  return clamp(Math.floor(t * NF), 0, NF - 1);
}

/**
 * @typedef {object} MorphInput
 * @property {boolean} beat createBeat's `beat`
 * @property {boolean} tempo createBeat's `tempo`
 * @property {number} period createBeat's `period` (s)
 * @property {boolean} onset @property {number} onsetStrength
 * @property {number} centroid `audio.centroid`
 * @property {number} morph the Morph param, 0–1: how far each step travels towards its family
 * @property {boolean} reduceMotion
 */

/**
 * Morph targets for the warp. Steps once per bar when the tempo is confident, on strong onsets
 * otherwise. On a step the smoothed centroid picks a family; the target weights move `morph` of
 * the way to it and the field's turn sways; then the weights and turn ease there with a
 * smoothstep over EASE_BEATS (never a snap). `wA`/`thetaA` drive set A of lib/tess.js
 * createWarp; set B (the other end of the spatial metamorphosis) is the complementary family
 * mix (lobed ↔ star, finned ↔ hooked), turned the other way.
 */
export function createMorph() {
  const from = new Float32Array(NF);
  const to = new Float32Array(NF);
  to[START_FAMILY] = 1;
  from.set(to);
  let thetaFrom = 0;
  let thetaTo = 0;
  let u = 1;
  let ease = 1;
  let beats = 0;
  let sinceStep = Infinity;
  let centroid = NaN;
  let steps = 0;
  const m = {
    wA: Float32Array.from(to),
    wB: new Float32Array(NF),
    thetaA: 0,
    thetaB: 0,
    /** True on the frame a step starts. */
    stepped: false,
    /** Family the latest step headed for. */
    family: START_FAMILY,
    /** @param {number} dt @param {MorphInput} o */
    step(dt, o) {
      centroid = Number.isNaN(centroid) ? o.centroid : centroid + (o.centroid - centroid) * (1 - Math.exp(-dt / CENTROID_TAU));
      sinceStep += dt;
      let step = false;
      if (o.tempo) {
        if (o.beat && ++beats % (STEP_BEATS * (o.reduceMotion ? REDUCED_STEP : 1)) === 0) step = true;
      } else if (o.onset && o.onsetStrength >= STEP_STRENGTH && sinceStep >= MIN_STEP_GAP) {
        step = true;
      }
      m.stepped = step;
      if (step) {
        sinceStep = 0;
        steps++;
        const amt = clamp(o.morph, 0, 1);
        m.family = centroidFamily(centroid);
        for (let f = 0; f < NF; f++) {
          from[f] = m.wA[f];
          to[f] += ((f === m.family ? 1 : 0) - to[f]) * amt;
        }
        thetaFrom = m.thetaA;
        thetaTo = amt * THETA_SWAY * ((steps % 3) - 1);
        u = 0;
        ease = Math.max(MIN_EASE, EASE_BEATS * o.period) * (o.reduceMotion ? REDUCED_EASE : 1);
      }
      u = Math.min(1, u + dt / ease);
      const k = smooth(u);
      for (let f = 0; f < NF; f++) m.wA[f] = from[f] + (to[f] - from[f]) * k;
      for (let f = 0; f < NF; f++) m.wB[f] = m.wA[(f + 2) % NF];
      m.thetaA = thetaFrom + (thetaTo - thetaFrom) * k;
      m.thetaB = -m.thetaA;
      return m;
    },
  };
  for (let f = 0; f < NF; f++) m.wB[f] = m.wA[(f + 2) % NF];
  return m;
}

/** Glide speed at Speed 1 with no music: plane units (flat), floor travel or Droste zoom per s. */
export const GLIDE_BASE = 1;
/** Speed added per unit of bass above its average (bassAtt − 1, −0.5…1), at Reactivity 1. */
export const BASS_GAIN = 0.6;
/** Speed added at the peak of a beat surge, at Reactivity 1. */
export const SURGE_GAIN = 0.35;
/** The surge follows the beat envelope through this lag (s), so speed eases, never jumps. */
const SURGE_TAU = 0.12;
const BASS_TAU = 0.4;
/** Reduce motion: glide this much slower. */
export const REDUCED_GLIDE = 0.25;

/**
 * @typedef {object} GlideInput
 * @property {number} bassAtt `audio.bassAtt` (1 while silent)
 * @property {number} env createBeat's `env`
 * @property {number} reactivity @property {number} speed the Speed param
 * @property {boolean} reduceMotion
 */

/** How fast the view travels (floor glide, Droste zoom, flat drift): bass, plus a surge per beat. */
export function createGlide() {
  let bass = 0;
  let surge = 0;
  const g = {
    /** Relative speed (GLIDE_BASE at rest). */
    speed: 0,
    /** Unwrapped distance travelled. */
    travel: 0,
    /** @param {number} dt @param {GlideInput} o */
    step(dt, o) {
      bass += (clamp(o.bassAtt - 1, -0.5, 1) - bass) * (1 - Math.exp(-dt / BASS_TAU));
      surge += (o.env - surge) * (1 - Math.exp(-dt / SURGE_TAU));
      const react = clamp(o.reactivity, 0, 2);
      const scale = Math.max(0, o.speed) * (o.reduceMotion ? REDUCED_GLIDE : 1);
      g.speed = scale * GLIDE_BASE * (1 + react * (BASS_GAIN * bass + SURGE_GAIN * surge));
      g.travel += g.speed * dt;
      return g;
    },
  };
  return g;
}

/** Tempo beats in a phrase (8 bars): the figure/ground inversion comes on phrase changes… */
export const PHRASE_BEATS = 32;
/** …or on an onset at least this strong. */
export const BIG_ONSET = 0.92;
/** Seconds between inversion starts at the least (the flash limit), and Reduce flashing's. */
export const INVERT_GAP = 8;
export const REDUCED_INVERT_GAP = 24;
/** Seconds an inversion's front takes to cross the view, and Reduce flashing's. */
export const INVERT_TIME = 3.2;
export const REDUCED_INVERT_TIME = 19.2;
/** Front width (fraction of the view's depth): how many rings of tiles change at once. */
export const FRONT_WIDTH = 0.35;
export const REDUCED_FRONT_WIDTH = 0.2;

/**
 * A tile's progress through the cross-fade (mirrors tess.glsl tessShade): the front sweeps from
 * the near/central rings (0) to the far ones (1), each tile easing in with a smoothstep.
 * @param {number} front @param {number} width @param {number} ring 0–1
 */
export const tileFade = (front, width, ring) => smooth(clamp((front - ring) / width + 0.5, 0, 1));

/**
 * @typedef {object} InversionInput
 * @property {boolean} beat @property {boolean} tempo createBeat's
 * @property {boolean} onset @property {number} onsetStrength
 * @property {number} reactivity
 * @property {boolean} reduceFlashing
 */

/**
 * Figure/ground inversion: the colour classes shift one palette slot (lib/tess.js classColor),
 * so the light tiles become the ground. It comes on phrase changes or big onsets and plays as a
 * front sweeping across the rings of tiles, each tile easing between its colours. Flash-limited:
 * at most one start per INVERT_GAP, never one while another runs, and a slow front. Reduce
 * flashing: rarer, much slower and narrower (fewer tiles changing at once).
 */
export function createInversion() {
  let beats = 0;
  let since = Infinity;
  let p = 0;
  const v = {
    /** Colour shift in place (the classes show slot cls + shift). */
    shift: 0,
    /** True while an inversion runs. */
    active: false,
    /** True on the frame one starts. */
    started: false,
    /** Front position, for tileFade. */
    front: -FRONT_WIDTH / 2,
    width: FRONT_WIDTH,
    /** @param {number} dt @param {InversionInput} o */
    step(dt, o) {
      since += dt;
      const reduce = o.reduceFlashing;
      v.width = reduce ? REDUCED_FRONT_WIDTH : FRONT_WIDTH;
      let want = false;
      if (o.tempo && o.beat && ++beats % PHRASE_BEATS === 0) want = true;
      if (o.onset && o.onsetStrength >= BIG_ONSET) want = true;
      v.started = want && o.reactivity > 0 && !v.active && since >= (reduce ? REDUCED_INVERT_GAP : INVERT_GAP);
      if (v.started) {
        v.active = true;
        since = 0;
        p = 0;
      }
      if (v.active) {
        p = Math.min(1, p + dt / (reduce ? REDUCED_INVERT_TIME : INVERT_TIME));
        if (p >= 1) {
          v.active = false;
          v.shift++;
          p = 0;
        }
      }
      v.front = -v.width / 2 + smooth(p) * (1 + v.width);
      return v;
    },
  };
  return v;
}

/** Rings of tiles the spectrum is spread over, near (low bands) to far (high bands). */
export const RINGS = 16;
const RING_TAU = 0.15;

/** The 64 bands averaged into RINGS rings and eased, × Reactivity / 2 (subtle by design). */
export function createRings() {
  const out = new Float32Array(RINGS);
  return {
    /** @param {Float32Array} bands `audio.bands` @param {number} dt @param {number} reactivity */
    step(bands, dt, reactivity) {
      const per = bands.length / RINGS;
      const a = 1 - Math.exp(-dt / RING_TAU);
      const react = clamp(reactivity, 0, 2) / 2;
      for (let r = 0; r < RINGS; r++) {
        let sum = 0;
        for (let i = Math.floor(r * per); i < Math.floor((r + 1) * per); i++) sum += bands[i];
        const target = react === 0 ? 0 : clamp((sum / per) * 2 * react, 0, 1);
        out[r] = react === 0 ? 0 : out[r] + (target - out[r]) * a;
      }
      return out;
    },
  };
}

/**
 * Each class's colour now (`now`) and after the shift under way (`next`), 3 floats per class,
 * from a lib/tess.js paletteOf array. Slots are classColor(cls, shift, n): neighbours always differ.
 * @param {Float32Array} pal @param {number} n tile colours @param {number} classes 2 or 3
 * @param {number} shift @param {Float32Array} now @param {Float32Array} next length ≥ 9
 */
export function classColors(pal, n, classes, shift, now, next) {
  for (let c = 0; c < classes; c++) {
    const a = 6 + classColor(c, shift, n) * 3;
    const b = 6 + classColor(c, shift + 1, n) * 3;
    for (let i = 0; i < 3; i++) {
      now[c * 3 + i] = pal[a + i];
      next[c * 3 + i] = pal[b + i];
    }
  }
}

/**
 * Tile features per family (lib/tess.js FAMILIES order): eye, spine, fin strokes, star rosette.
 * Original marks: a ringed eye, an arched spine with fins (lobed, finned), feather strokes
 * (hooked), a five-point rosette (star).
 */
const FEATURES = [
  [1, 1, 0.35, 0],
  [1, 0.6, 1, 0],
  [0.25, 0, 0, 1],
  [1, 0, 0.7, 0],
];

/** Feature weights for a family mix. @param {ArrayLike<number>} w @param {Float32Array} out length 4 */
export function featureWeights(w, out) {
  for (let i = 0; i < 4; i++) {
    let v = 0;
    for (let f = 0; f < FEATURES.length; f++) v += w[f] * FEATURES[f][i];
    out[i] = v;
  }
  return out;
}

/** Symmetry param options (lib/tess.js groups). */
export const SYMMETRIES = ["p4", "p3"];
/** @param {unknown} name → a group name, "p4" if unknown */
export const symmetryName = (name) => (SYMMETRIES.includes(String(name)) ? String(name) : "p4");
/** Quality param: render scale of the print pass. */
export const QUALITIES = ["low", "medium", "high"];
const SCALES = [0.5, 0.75, 1];
/** @param {unknown} name → render scale, 1 if unknown */
export const renderScale = (name) => SCALES[QUALITIES.indexOf(String(name))] ?? 1;
/** Outline half-width (px) at Ink 1 on a 1440-px-high canvas. */
const INK_PX = 2.6;
/** Outline half-width in full-resolution px. @param {number} ink the Ink param @param {number} height canvas px */
export const inkWidth = (ink, height) => Math.max(0, ink) * INK_PX * (height / 1440);

/**
 * Spatial metamorphosis wave per group: m(p) = ½ + ½ sin(2π k·p + φ), k a dual-lattice vector
 * over BLEND_PERIOD, so the field repeats every BLEND_PERIOD lattice steps (offsets wrap there).
 */
export const BLEND_PERIOD = 6;
const BLEND_K = {
  p4: [1 / BLEND_PERIOD, 0],
  p3: [1 / BLEND_PERIOD, -1 / (BLEND_PERIOD * Math.sqrt(3))],
};
/** The wave's phase moves this many radians per unit of glide travel. */
const BLEND_DRIFT = 0.15;
/** Colour blocks' registration offset against the key block, px at a 1440-px-high canvas. */
const REG_PX = [0.9, -0.6];
/** Outlines darken the mean colour of tiles too small to draw by this much. */
const AVG_INK = 0.12;

/** sRGB 0–1 → linear (the print pass mixes in linear light). @param {number} c */
const toLinear = (c) => Math.pow(c, 2.2);

/**
 * @typedef {object} TessOptions the visualizer's params and ctx flags
 * @property {string} symmetry "p4" | "p3" @property {string} palette lib/tess.js PALETTES
 * @property {number} reactivity 0–2 @property {number} speed @property {number} morph 0–1
 * @property {number} ink outline weight @property {number} hatching 0–1
 * @property {number} height canvas height (px), for print weights
 * @property {boolean} reduceMotion @property {boolean} reduceFlashing
 */

/**
 * @typedef {object} TessAudio the fields of an AudioFrame the state reads
 * @property {Float32Array} bands @property {number} bpm @property {number} beatPhase
 * @property {boolean} onset @property {number} onsetStrength @property {number} centroid
 * @property {number} bassAtt @property {boolean} silent
 */

/**
 * The seam between the music and any tessellation surface: one `step` per frame turns the
 * audio and the options into everything tess.glsl's uniforms need (lib/tess-gl.js uploads it),
 * plus the glide (`speed`, `travel`) a surface uses for its own motion. Arrays are filled in
 * place; nothing is allocated per frame.
 */
export function createTessState() {
  const beat = createBeat();
  const morph = createMorph();
  const glide = createGlide();
  const inversion = createInversion();
  const rings = createRings();
  /** @type {Record<string, ReturnType<typeof createWarp>>} */
  const warps = { p4: createWarp(groupOf("p4")), p3: createWarp(groupOf("p3")) };
  const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
  const now = new Float32Array(9);
  const next = new Float32Array(9);
  let palName = "";
  let nTiles = 0;
  let centroid = 0.15;
  const blend = { kx: 0, ky: 0, phase: 0 };
  const beatIn = { bpm: 0, beatPhase: 0, onset: false, onsetStrength: 0 };
  const morphIn = { beat: false, tempo: false, period: 0.5, onset: false, onsetStrength: 0, centroid: 0, morph: 1, reduceMotion: false };
  const glideIn = { bassAtt: 1, env: 0, reactivity: 1, speed: 1, reduceMotion: false };
  const invIn = { beat: false, tempo: false, onset: false, onsetStrength: 0, reactivity: 1, reduceFlashing: false };
  const s = {
    group: groupOf("p4"),
    /** Colour classes: 2 (p4) or 3 (p3). */
    classes: 2,
    /** Terms in use (`u_tN`). */
    nTerms: groupOf("p4").n,
    /** Per term kx, ky, φ, 0 (`u_tK`) and amplitudes A.xy B.xy (`u_tAB`). */
    k: groupOf("p4").k,
    ab: warps.p4.ab,
    /** Spatial blend wave: kx, ky, φ (`u_tBlend`). */
    blend: new Float32Array(3),
    /** Linear colours: paper, ink, per class now and after the shift, mean (`u_tPaper` …). */
    paper: new Float32Array(3),
    ink: new Float32Array(3),
    cls: new Float32Array(9),
    clsNext: new Float32Array(9),
    avg: new Float32Array(3),
    /** Inversion front, width, 0 (`u_tInvert`). */
    invert: new Float32Array(3),
    /** Outline half-width, full-resolution px (`u_tInkW`). */
    inkW: 0,
    /** Hatching 0–1 (`u_tHatch`). */
    hatch: 0,
    /** Registration offset of the colour blocks, full-resolution px (`u_tReg`). */
    reg: new Float32Array(2),
    /** Spectrum per ring of tiles (`u_tBands`). */
    bands: new Float32Array(RINGS),
    /** Feature weights of set A and B: eye, spine, fins, star (`u_tFeatA`, `u_tFeatB`). */
    featA: new Float32Array(4),
    featB: new Float32Array(4),
    /** Beat envelope 0–1, glide speed and travel, latest morph step, colour shift. */
    env: 0,
    speed: 0,
    travel: 0,
    stepped: false,
    family: START_FAMILY,
    shift: 0,
    /** @param {TessAudio} audio @param {number} dt @param {TessOptions} o */
    step(audio, dt, o) {
      const live = !audio.silent;
      const name = o.symmetry === "p3" ? "p3" : "p4";
      const g = groupOf(name);
      s.group = g;
      s.classes = name === "p3" ? 3 : 2;
      s.nTerms = g.n;
      s.k = g.k;

      beatIn.bpm = live ? audio.bpm : 0;
      beatIn.beatPhase = audio.beatPhase;
      beatIn.onset = live && audio.onset;
      beatIn.onsetStrength = live ? audio.onsetStrength : 0;
      beat.step(beatIn, dt);
      s.env = beat.env;
      if (live) centroid = audio.centroid;

      morphIn.beat = beat.beat;
      morphIn.tempo = beat.tempo;
      morphIn.period = beat.period;
      morphIn.onset = beatIn.onset;
      morphIn.onsetStrength = beatIn.onsetStrength;
      morphIn.centroid = centroid;
      morphIn.morph = o.morph;
      morphIn.reduceMotion = o.reduceMotion;
      morph.step(dt, morphIn);
      s.stepped = morph.stepped;
      s.family = morph.family;

      glideIn.bassAtt = live ? audio.bassAtt : 1;
      glideIn.env = beat.env;
      glideIn.reactivity = o.reactivity;
      glideIn.speed = o.speed;
      glideIn.reduceMotion = o.reduceMotion;
      glide.step(dt, glideIn);
      s.speed = glide.speed;
      s.travel = glide.travel;

      invIn.beat = beat.beat;
      invIn.tempo = beat.tempo;
      invIn.onset = beatIn.onset;
      invIn.onsetStrength = beatIn.onsetStrength;
      invIn.reactivity = o.reactivity;
      invIn.reduceFlashing = o.reduceFlashing;
      inversion.step(dt, invIn);
      s.shift = inversion.shift;
      s.invert[0] = inversion.front;
      s.invert[1] = inversion.width;

      const bk = BLEND_K[name];
      blend.kx = bk[0];
      blend.ky = bk[1];
      blend.phase = (BLEND_DRIFT * glide.travel) % (2 * Math.PI);
      s.blend[0] = blend.kx;
      s.blend[1] = blend.ky;
      s.blend[2] = blend.phase;
      const w = warps[name].set(morph.wA, morph.thetaA, morph.wB, morph.thetaB, blend);
      s.ab = w.ab;
      featureWeights(morph.wA, s.featA);
      featureWeights(morph.wB, s.featB);

      if (o.palette !== palName) {
        palName = o.palette;
        nTiles = paletteOf(palName, pal);
      }
      classColors(pal, nTiles, s.classes, inversion.shift, now, next);
      const along = clamp(inversion.front + 0.5 * inversion.width, 0, 1);
      for (let i = 0; i < 3; i++) {
        s.paper[i] = toLinear(pal[i]);
        s.ink[i] = toLinear(pal[3 + i]);
        let mean = 0;
        for (let c = 0; c < s.classes; c++) {
          s.cls[c * 3 + i] = toLinear(now[c * 3 + i]);
          s.clsNext[c * 3 + i] = toLinear(next[c * 3 + i]);
          mean += s.cls[c * 3 + i] + (s.clsNext[c * 3 + i] - s.cls[c * 3 + i]) * along;
        }
        s.avg[i] = (mean / s.classes) * (1 - AVG_INK) + s.ink[i] * AVG_INK;
      }
      s.inkW = inkWidth(o.ink, o.height);
      s.hatch = clamp(o.hatching, 0, 1);
      s.reg[0] = (REG_PX[0] * o.height) / 1440;
      s.reg[1] = (REG_PX[1] * o.height) / 1440;
      s.bands.set(rings.step(audio.bands, dt, live ? o.reactivity : 0));
      return s;
    },
  };
  return s;
}
