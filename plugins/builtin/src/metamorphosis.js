// @ts-check
/**
 * Metamorphosis — an interlocking tiling that changes shape with the music, printed like a
 * multi-block woodcut, for the `webgl2` renderer. The first of the tessellation visualizers.
 *
 * The engine (lib/tess.js, shaders/tess/tess.glsl) warps a regular p4 or p3 tiling with a smooth
 * field that has the group's symmetry and stays invertible, so the tiles stay a perfect tiling
 * while they turn into hooked, lobed, finned or star-like creatures. The field blends between
 * two motif mixes across the plane (a metamorphosis strip) and its targets step with the music
 * (lib/tess-music.js): once a bar with a confident tempo (strong onsets otherwise), easing over a
 * beat and a half; the spectral centroid picks the family (dark → lobed, bright → hooked); bass
 * and an eased beat surge set the drift; phrase changes and big onsets sweep a figure/ground
 * inversion across the tiles; the spectrum's bands tune the gouges ring by ring.
 *
 * This surface is the flat one: the plane fills the screen and drifts. lib/tess-gl.js renders
 * the print at the Quality scale and presses it into paper at full resolution. frame()
 * allocates nothing.
 *
 * Relief (the showcase of the engine's carved block, TESS_RELIEF): the plane becomes the block
 * the print is pulled from, seen from a camera above it under a raking light (the Light param),
 * relief-mapped with soft shadows. Every beat sends a wave of tiles lifting out from the centre,
 * the spectrum heaves the rings (bass inner, treble outer), onsets pop single tiles, and the
 * figure/ground front turns the tiles over like cards. Relief 0 is the flat print, unchanged.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { BLEND_PERIOD, createTessState, lightDir, reliefParam, renderScale, symmetryName } from "./lib/tess-music.js";

/** Plane units per half the short side of the view (p4 tiles are half a unit: ~9 across). */
const ZOOM = 2.3;
/** Drift (plane units per second at glide speed 1) and its slow change of heading (rad/s). */
const DRIFT = 0.12;
const HEADING_RATE = 0.031;
/** Slow turn of the whole view (rad per unit of glide travel). */
const TURN = 0.006;
/** Ring scale: the screen's corners are ring 1 (half-diagonal of 16:9 in half-short-side units). */
const RING_SPAN = 2.05;
/** Relief camera height above the block, in half-short-sides of the view (perspective parallax). */
const CAM_DIST = 2.2;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/metamorphosis.frag", { relief: true });
  const state = createTessState();
  const opts = {
    symmetry: "p4",
    palette: "",
    reactivity: 1,
    speed: 1,
    morph: 0.7,
    ink: 1,
    hatching: 0.6,
    height: 1,
    reduceMotion: false,
    reduceFlashing: false,
    relief: 0,
  };
  const light = new Float32Array(3);
  let ox = 0.37;
  let oy = 0.21;
  let clock = 0;
  let lastTravel = 0;
  let cr = 1;
  let sr = 0;

  tess.resize(renderScale(ctx.params.quality));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    gl.uniform2f(u.u_O, ox, oy);
    gl.uniform2f(u.u_rot, cr, sr);
    gl.uniform1f(u.u_zoom, ZOOM);
    gl.uniform3f(u.u_tRing, ox, oy, ZOOM * RING_SPAN);
    gl.uniform3fv(u.u_light, light); // relief programs only (null elsewhere: a no-op)
    gl.uniform1f(u.u_camD, CAM_DIST * ZOOM);
  };

  return {
    frame(audio, time) {
      const dt = time.dt;
      const p = ctx.params;
      opts.symmetry = symmetryName(p.symmetry);
      opts.palette = String(p.palette);
      opts.reactivity = Number(p.reactivity);
      opts.speed = Number(p.speed);
      opts.morph = Number(p.morph);
      opts.ink = Number(p.ink);
      opts.hatching = Number(p.hatching);
      opts.height = ctx.size.height;
      opts.reduceMotion = ctx.reduceMotion;
      opts.reduceFlashing = ctx.reduceFlashing;
      opts.relief = reliefParam(p.relief);
      lightDir(Number(p.light), light);
      const s = state.step(audio, dt, opts);

      // Drift along a slowly turning heading; the view turns a little as it travels.
      const step = s.travel - lastTravel;
      lastTravel = s.travel;
      clock += dt * (ctx.reduceMotion ? 0.25 : 1);
      const heading = 0.6 + 0.9 * Math.sin(clock * HEADING_RATE);
      ox += Math.cos(heading) * DRIFT * step;
      oy += Math.sin(heading) * DRIFT * step;
      // Keep the offset small: the tiling and the metamorphosis wave both repeat every
      // BLEND_PERIOD lattice steps, so wrap there (in lattice coordinates).
      const b = s.group.basis;
      const det = b[0][0] * b[1][1] - b[1][0] * b[0][1];
      let la = (ox * b[1][1] - oy * b[1][0]) / det;
      let lb = (oy * b[0][0] - ox * b[0][1]) / det;
      la -= BLEND_PERIOD * Math.floor(la / BLEND_PERIOD);
      lb -= BLEND_PERIOD * Math.floor(lb / BLEND_PERIOD);
      ox = la * b[0][0] + lb * b[1][0];
      oy = la * b[0][1] + lb * b[1][1];
      const turn = TURN * s.travel;
      cr = Math.cos(turn);
      sr = Math.sin(turn);

      tess.render(s, surface);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
    },

    dispose() {
      tess.dispose();
    },
  };
}
