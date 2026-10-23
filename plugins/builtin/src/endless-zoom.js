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
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, renderScale } from "./lib/tess-music.js";
import { createDrag, createZoom, readParams, ringSpan, VANISH } from "./lib/tess-zoom.js";

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/endless-zoom.frag");
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
  };
  const zoomIn = { group: state.group, spiral: "", zoomSpeed: 1, direction: "in" };
  const span = [0, 0];
  let lastTravel = 0;
  let flip = 0;

  tess.resize(renderScale(ctx.params.quality));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u, w, h) => {
    const hs = 0.5 * Math.min(w, h);
    ringSpan((0.5 * w) / hs, (0.5 * h) / hs, drag.x, drag.y, span);
    gl.uniform2f(u.u_O, zoom.ox, zoom.oy);
    gl.uniform2f(u.u_alpha, zoom.alpha[0], zoom.alpha[1]);
    gl.uniform3f(u.u_ring, span[0], span[1], flip);
    gl.uniform2f(u.u_vp, drag.x, drag.y);
    gl.uniform3f(u.u_vanish, VANISH[0], VANISH[1], 0.5 - 0.5 * zoom.dir);
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

      tess.render(s, surface);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
    },

    pointer(e) {
      drag.pointer(e.kind, e.dx, e.dy, 0.5 * Math.min(ctx.size.cssWidth, ctx.size.cssHeight));
    },

    dispose() {
      tess.dispose();
    },
  };
}
