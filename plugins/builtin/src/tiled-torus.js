// @ts-check
/**
 * Tiled Torus — the interlocking tiling wrapped around a torus, printed like a multi-block
 * woodcut, for the `webgl2` renderer. Seen from outside (the torus tumbles slowly over paper) or
 * from inside the tube (the camera flies along the ring, the tiled walls wrapping round it, fog
 * down the tube); Auto dives in on a phrase change and back out on a later one.
 *
 * A torus is doubly periodic, so the plane tiling wraps it exactly: conformal coordinates of the
 * torus (θ around the ring, t(φ) around the tube) are scaled by lattice counts that are periods
 * of the warped, coloured tiling (lib/torus.js), so tiles are square and the tiling closes both
 * ways. The engine (lib/tess-gl.js, shaders/tess/tess.glsl) and the music (lib/tess-music.js)
 * are Metamorphosis's; this surface is shaders/tess/torus.frag. Glide travel (bass and an eased
 * beat surge) drives the orbit, the fly speed and the tiles' flow along the tube; the
 * figure/ground front travels around the ring from the camera. frame() allocates nothing.
 */
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, renderScale } from "./lib/tess-music.js";
import { createTorusCamera, latticeCounts, mapParams } from "./lib/torus.js";

/** March steps per Quality (low, medium, high). */
const STEPS = { low: 64, medium: 80, high: 96 };

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/torus.frag");
  const state = createTessState();
  const cam = createTorusCamera();
  const counts = { nu: 0, nv: 0, lx: 0, ly: 0 };
  const p = {
    view: "auto",
    symmetry: "p4",
    thickness: 0.36,
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
  const camIn = { view: "auto", thickness: 0.36, stepped: false, reduceMotion: false };
  let steps = STEPS.high;

  const setQuality = () => {
    const q = String(ctx.params.quality);
    steps = q === "low" ? STEPS.low : q === "medium" ? STEPS.medium : STEPS.high;
    tess.resize(renderScale(q));
  };
  setQuality();

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    const c = cam.pose;
    gl.uniform2f(u.u_lxy, counts.lx, counts.ly);
    gl.uniform1f(u.u_ringO, cam.ringO);
    gl.uniform3f(u.u_cam, c.pos[0], c.pos[1], c.pos[2]);
    gl.uniform3f(u.u_fwd, c.fwd[0], c.fwd[1], c.fwd[2]);
    gl.uniform3f(u.u_up, c.up[0], c.up[1], c.up[2]);
    gl.uniform1f(u.u_tan, cam.tanHalf);
    gl.uniform1f(u.u_k, p.thickness);
    gl.uniform2f(u.u_flow, cam.fu, cam.fv);
    gl.uniform1f(u.u_side, cam.side);
    gl.uniform1f(u.u_mix, cam.mix);
    gl.uniform1f(u.u_fade, cam.fade);
    gl.uniform1i(u.u_steps, steps);
  };

  return {
    frame(audio, time) {
      mapParams(ctx.params, p);
      p.height = ctx.size.height;
      p.reduceMotion = ctx.reduceMotion;
      p.reduceFlashing = ctx.reduceFlashing;
      const s = state.step(audio, time.dt, p);
      latticeCounts(p.symmetry, p.thickness, counts);
      camIn.view = p.view;
      camIn.thickness = p.thickness;
      camIn.stepped = s.stepped;
      camIn.reduceMotion = ctx.reduceMotion;
      cam.step(time.dt, s, camIn);
      tess.render(s, surface);
    },

    pointer(e) {
      cam.pointer(e);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) setQuality();
    },

    dispose() {
      tess.dispose();
    },
  };
}
