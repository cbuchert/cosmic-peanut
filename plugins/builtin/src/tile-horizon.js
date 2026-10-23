// @ts-check
/**
 * Tile Horizon — the tessellation plane as an endless floor, seen in perspective from a camera
 * gliding low over it, receding to a horizon that fades into the paper. The second surface on
 * the tessellation engine (lib/tess.js, shaders/tess/tess.glsl): the same woodcut print,
 * motifs, palettes and music as Metamorphosis (lib/tess-music.js), cast onto the ground.
 *
 * The glide is the state's travel (bass and an eased beat surge); the heading drifts slowly
 * (lib/tess-floor.js). Drag pans and tilts the view and eases back after release. Rings are by
 * distance from the camera, so figure/ground fronts and the spectrum rings sweep outwards across
 * the floor. frame() allocates nothing.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { basePitch, cameraHeight, createFloorCamera, fogDistance } from "./lib/tess-floor.js";
import { createTessState, renderScale, symmetryName } from "./lib/tess-music.js";

/** Focal length in half-short-side units (~32° half the short side's field of view). */
const FOCAL = 1.6;
/** Ring 1 at this fraction of the fog distance (where the floor is mostly paper). */
const RING_SPAN = 0.6;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/tile-horizon.frag");
  const state = createTessState();
  const camera = createFloorCamera();
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
  const camIn = { travel: 0, height: 1, pitch: 0.3, reduceMotion: false, basis: state.group.basis };
  let fog = 1;

  tess.resize(renderScale(ctx.params.quality));

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    gl.uniform3f(u.u_cam, camera.x, camera.y, camera.h);
    gl.uniform1f(u.u_ringR, fog * RING_SPAN);
    gl.uniform3fv(u.u_fwd, camera.fwd);
    gl.uniform3fv(u.u_right, camera.right);
    gl.uniform3fv(u.u_up, camera.up);
    gl.uniform1f(u.u_focal, FOCAL);
    gl.uniform1f(u.u_fog, fog);
  };

  return {
    frame(audio, time) {
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
      const s = state.step(audio, time.dt, opts);

      camIn.travel = s.travel;
      camIn.height = cameraHeight(p.height);
      camIn.pitch = basePitch(p.tilt);
      camIn.reduceMotion = ctx.reduceMotion;
      camIn.basis = s.group.basis;
      camera.step(time.dt, camIn);
      fog = fogDistance(p.fog, camIn.height);

      tess.render(s, surface);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) tess.resize(renderScale(ctx.params.quality));
    },

    pointer(e) {
      camera.pointer(e);
    },

    dispose() {
      tess.dispose();
    },
  };
}
