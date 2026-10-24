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
 *
 * Relief (the engine's carved block, TESS_RELIEF, as in Metamorphosis): the floor is the block
 * and its tiles rise off it, raymarched through a height map in the camera's perspective, with
 * soft shadows under a low raking light (the Light param, round the view). Every beat rolls a wave
 * of tiles lifting off the floor out towards the horizon, the spectrum heaves the rings (bass
 * near, treble far), onsets pop single tiles, and the figure/ground front tips the tiles over
 * like cards, away from the camera. The relief fades out with distance well before the horizon.
 * Relief 0 is the flat floor, unchanged.
 *
 * Look (lib/tess-look.js): cinematic lights the block with print materials and horizon AO
 * (shaders/tess/look.glsl), focuses on the floor a few heights ahead (depth of field, eased and
 * held under Reduce motion) and fogs towards a slightly cooler paper at the horizon.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import {
  basePitch,
  cameraHeight,
  createFloorCamera,
  FADE_FAR,
  FADE_NEAR,
  floorLight,
  fogDistance,
  heightFrame,
  marchTop,
  reliefScale,
} from "./lib/tess-floor.js";
import { createFocus } from "./lib/tess-look.js";
import { createTessState, reliefParam, renderScale, symmetryName } from "./lib/tess-music.js";

/** Focal length in half-short-side units (~32° half the short side's field of view). */
const FOCAL = 1.6;
/** Ring 1 at this fraction of the fog distance (where the floor is mostly paper). */
const RING_SPAN = 0.6;
/**
 * Cinematic depth of field: focus on the floor this many camera heights ahead; the blur far
 * away and its cap up close (full-resolution px on a 1440-px-high canvas). Near floor softens
 * towards the bottom edge, the far floor towards the horizon.
 */
const FOCUS_AHEAD = 4;
const DOF_FAR = 4;
const DOF_CAP = 9;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/tile-horizon.frag", { relief: true, dof: true });
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
    relief: 0,
  };
  const camIn = { travel: 0, height: 1, pitch: 0.3, reduceMotion: false, basis: state.group.basis };
  let fog = 1;
  const light = new Float32Array(3);
  const frame = new Float64Array(2);
  let scale = 1;
  let top = 0;
  let hsPrint = 1;

  tess.resize(renderScale(ctx.params.quality));
  await tess.setLook(ctx.params.look, ctx.params.quality);
  const focus = createFocus(1);
  let focused = false;

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    gl.uniform3f(u.u_cam, camera.x, camera.y, camera.h);
    gl.uniform1f(u.u_ringR, fog * RING_SPAN);
    gl.uniform3fv(u.u_fwd, camera.fwd);
    gl.uniform3fv(u.u_right, camera.right);
    gl.uniform3fv(u.u_up, camera.up);
    gl.uniform1f(u.u_focal, FOCAL);
    gl.uniform1f(u.u_fog, fog);
    // Relief programs only (null on the flat one: a no-op).
    gl.uniform2f(u.u_hFrame, frame[0], frame[1]);
    gl.uniform2f(u.u_rel, scale, top);
    gl.uniform2f(u.u_fadeR, FADE_NEAR * camera.h, FADE_FAR * camera.h);
    gl.uniform1f(u.u_hsPrint, hsPrint);
    gl.uniform3fv(u.u_light, light);
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
      opts.relief = reliefParam(p.relief);
      const s = state.step(audio, time.dt, opts);

      camIn.travel = s.travel;
      camIn.height = cameraHeight(p.height);
      camIn.pitch = basePitch(p.tilt);
      camIn.reduceMotion = ctx.reduceMotion;
      camIn.basis = s.group.basis;
      camera.step(time.dt, camIn);
      fog = fogDistance(p.fog, camIn.height);
      scale = reliefScale(camera.h);
      top = marchTop(s.reliefMax, camera.h);
      heightFrame(camera.h, camera.pitch, FOCAL, top, frame);
      floorLight(Number(p.light), camera.yaw, light);
      hsPrint = 0.5 * Math.min(ctx.size.width, ctx.size.height) * renderScale(p.quality);

      // Cinematic: focus on the floor a few heights ahead (its depth along the view), eased;
      // Reduce motion holds it (no focus pulling).
      const f = camera.fwd;
      const ahead = FOCUS_AHEAD * camera.h * Math.hypot(f[0], f[1]) - camera.h * f[2];
      if (!focused) focus.reset(ahead);
      focused = true;
      focus.step(ahead, time.dt, ctx.reduceMotion);
      const px = ctx.size.height / 1440;
      const lr = light[0] * camera.right[0] + light[1] * camera.right[1] + light[2] * camera.right[2];
      const lu = light[0] * camera.up[0] + light[1] * camera.up[1] + light[2] * camera.up[2];
      const lh = Math.hypot(lr, lu) || 1;
      tess.setFocus(focus.distance, DOF_FAR * px, DOF_CAP * px, lr / lh, lu / lh);
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
      camera.pointer(e);
    },

    dispose() {
      tess.dispose();
    },
  };
}
