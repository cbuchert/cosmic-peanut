// @ts-check
/**
 * Endless Zoom — the woodcut tiling of Metamorphosis seen through a log-polar map, so it spirals
 * self-similarly into a vanishing point and the view zooms into it (or out of it) without end.
 * For the `webgl2` renderer.
 *
 * The surface (shaders/tess/endless-zoom.frag) maps each pixel z, relative to the vanishing
 * point, to the plane point p = α log z + O. α closes the lattice round the centre (one turn is
 * a lattice step that the metamorphosis wave also repeats over; lib/tess-zoom.js), so there is
 * no seam, and the Spiral param picks how far that step climbs. Zooming slides O along α at the
 * pace of the shared glide (bass, plus an eased beat surge), wrapping by whole blend periods.
 * The figure/ground fronts and spectrum rings run by log radius, so they ripple along the
 * spiral: outward while zooming in, inward while zooming out. Tiles too small to print fade into
 * a soft ink point (paper, zooming out). Drag moves the vanishing point; it eases home on
 * release. The music side is the engine's (lib/tess-music.js). frame() allocates nothing.
 *
 * Relief (the engine's carved block, TESS_RELIEF, as in Metamorphosis): the spiral is the block
 * the print is pulled from, relief-mapped through the log-polar map with soft shadows under a
 * raking light (the Light param, fixed to the screen). The map's analytic Jacobian carries the
 * heights, slopes and parallax, so the relief scales with the tiles at every radius and closes
 * across the seam (tiles are hashed by a cell key reduced modulo one turn: lib/tess-zoom.js
 * cellKey). Every beat lifts a wave of tiles that ripples along the spiral by log radius, the
 * spectrum heaves the rings, onsets pop single tiles and the figure/ground front turns the tiles
 * over radially, outward zooming in and inward zooming out. Relief fades out near the vanishing
 * point, where tiles are too small to carve. Relief 0 is the flat print, unchanged.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, lightDir, renderScale } from "./lib/tess-music.js";
import { createDrag, createZoom, readParams, ringSpan, VANISH } from "./lib/tess-zoom.js";

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/endless-zoom.frag", { relief: true });
  const state = createTessState();
  const zoom = createZoom();
  const drag = createDrag();
  /** @type {import('./lib/tess-zoom.js').ZoomParams} */
  const params = {
    symmetry: "p4",
    palette: "",
    reactivity: 1,
    speed: 1,
    morph: 0.7,
    ink: 1,
    hatching: 0.6,
    spiral: "",
    zoomSpeed: 1,
    direction: "in",
    relief: 0,
    light: 0,
  };
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
  const zoomIn = { group: state.group, spiral: "", zoomSpeed: 1, direction: "in" };
  const span = [0, 0];
  let lastTravel = 0;
  let flip = 0;

  tess.resize(renderScale(ctx.params.quality));
  await tess.setLook(ctx.params.look, ctx.params.quality);

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u, w, h) => {
    const hs = 0.5 * Math.min(w, h);
    ringSpan((0.5 * w) / hs, (0.5 * h) / hs, drag.x, drag.y, span);
    gl.uniform2f(u.u_O, zoom.ox, zoom.oy);
    gl.uniform2f(u.u_alpha, zoom.alpha[0], zoom.alpha[1]);
    gl.uniform3f(u.u_ring, span[0], span[1], flip);
    gl.uniform2f(u.u_vp, drag.x, drag.y);
    gl.uniform3f(u.u_vanish, VANISH[0], VANISH[1], 0.5 - 0.5 * zoom.dir);
    // Relief programs only (null elsewhere: a no-op).
    gl.uniform3fv(u.u_light, light);
    gl.uniform1f(u.u_hsFull, 0.5 * Math.min(ctx.size.width, ctx.size.height));
    gl.uniform4f(u.u_cellKey, zoom.cellBase[0], zoom.cellBase[1], zoom.seam[0], zoom.seam[1]);
  };

  return {
    frame(audio, time) {
      const dt = time.dt;
      readParams(ctx.params, params);
      opts.symmetry = params.symmetry;
      opts.palette = params.palette;
      opts.reactivity = params.reactivity;
      opts.speed = params.speed;
      opts.morph = params.morph;
      opts.ink = params.ink;
      opts.hatching = params.hatching;
      opts.height = ctx.size.height;
      opts.reduceMotion = ctx.reduceMotion;
      opts.reduceFlashing = ctx.reduceFlashing;
      opts.relief = params.relief;
      lightDir(params.light, light);
      const s = state.step(audio, dt, opts);

      zoomIn.group = s.group;
      zoomIn.spiral = params.spiral;
      zoomIn.zoomSpeed = params.zoomSpeed;
      zoomIn.direction = params.direction;
      zoom.step(s.travel - lastTravel, dt, zoomIn);
      lastTravel = s.travel;
      drag.step(dt);
      // Fronts ripple with the flow; the ring order only changes while no front is under way.
      if (s.invert[0] <= -0.5 * s.invert[1] + 1e-6) flip = params.direction === "out" ? 1 : 0;

      // Cinematic: no depth of field (the zoom is self-similar, no subject depth); the paper's
      // fibres catch the light, fixed to the screen.
      const ll = Math.hypot(light[0], light[1]) || 1;
      tess.setFocus(1, 0, 0, light[0] / ll, light[1] / ll);
      tess.render(s, surface);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
      if ("look" in changed || "quality" in changed) tess.setLook(ctx.params.look, ctx.params.quality);
    },

    pointer(e) {
      drag.pointer(e.kind, e.dx, e.dy, 0.5 * Math.min(ctx.size.cssWidth, ctx.size.cssHeight));
    },

    dispose() {
      tess.dispose();
    },
  };
}
