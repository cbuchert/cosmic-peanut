// @ts-check
/**
 * Lattice — an endless cubic lattice, a rounded cube at every node joined by rods along the three
 * axes, that the camera flies through, for the `webgl2` renderer.
 *
 * Render: one full-screen raymarch at reduced scale (Quality; shaders/lattice/lattice.frag) by
 * domain repetition over a cubic cell — exact distances, so it marches quickly down the empty
 * channels — with soft headlight + key lighting, five-sample ambient occlusion and exponential
 * fog to the palette's background (or to transparent, Background "none"). A full-resolution
 * composite (composite.frag) upsamples it to premultiplied sRGB.
 *
 * Motion (lib/lattice-camera.js): the camera flies a seeded walk through the free channels between
 * the rods (cell centre to cell centre, turning at intersections), smoothed by a cubic B-spline and
 * flown by arc length, looking a little ahead so turns are eased. Drag to look around; it eases
 * back on release.
 *
 * Music: the beat envelope (lib/lattice-beat.js: tempo-locked when confident, strong onsets
 * otherwise; an 80 ms smoothstep rise, back to 0 over 0.9 beat) adds an eased surge to the fly
 * speed (lib/lattice.js flySpeed). Each beat launches a light pulse (lib/lattice-pulses.js) from
 * the node nearest the path SOURCE_AHEAD cells ahead, and its front runs outward along the rods,
 * so the beat is seen landing at one place and spreading — nothing else in the scene pumps. The
 * spectrum lights the rods by axis (x bass, y mids, z treble; createAxisLight, flash-limited) and
 * feeds the cube faces: one history row per frame (lib/lattice-history.js) into a 64 × 256 RGBA8
 * ring, which faces scroll through. Reactivity scales all of it; Reduce flashing dims pulses and
 * axis light and spaces pulses ≥ 1/3 s apart; Reduce motion slows the flight (at the default
 * Speed), drops the surge, slows the rods' running light and shortens the pulses' travel.
 *
 * Tentacle Lattice (`ctx.id` "tentacle-lattice", lib/tentacle-lattice.js) is the same module with
 * TENTACLE defined in the shader: the rods become six swaying, tapered tentacles per node
 * (Tentacube's creature, procedural instead of verlet), materials crossfade (createMaterials),
 * each beat pulse makes the tentacles it passes reach and touch tips (the handshake), the pulse's
 * node twists a quarter turn (createTwists) and the nodes nearest the camera swell with the bass
 * (createSwell). Lattice itself renders exactly as before.
 *
 * Everything per frame writes into preallocated arrays: frame() allocates nothing.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import { createBeat } from "./lib/lattice-beat.js";
import { createCamera } from "./lib/lattice-camera.js";
import { createFaceHistory } from "./lib/lattice-history.js";
import { createPulses } from "./lib/lattice-pulses.js";
import {
  PALETTE_FLOATS,
  createAxisLight,
  flySpeed,
  fogDensity,
  geometry,
  motionScale,
  paletteOf,
  qualityOf,
} from "./lib/lattice.js";
import {
  createMaterials,
  createSwell,
  createSway,
  createTwists,
  envelopeMax,
  isTentacle,
  motionParams,
  tentacleGeometry,
} from "./lib/tentacle-lattice.js";

/** Vertical field of view (radians). */
const FOV = (68 * Math.PI) / 180;
/** Beat pulses launch from the node nearest the path this many cells ahead of the camera. */
const SOURCE_AHEAD = 1.6;
/** History ring: texels per row (bands) and rows. */
const HIST_W = 64;
const HIST_N = 256;
/** The march stops where the fog leaves under this much of a surface, or at MAX_FAR cells. */
const FOG_CUTOFF = 0.02;
const MAX_FAR = 36;
/** Tentacle Lattice's march budget, × Quality's steps. */
const TENTACLE_STEPS = 1.1;
/** Tentacle Lattice's render scale, × Quality's (it costs several times Lattice per pixel). */
const TENTACLE_SCALE = 0.85;
/** Tentacle Lattice: fog density × this, and the march stops by this many cells. */
const TENTACLE_FOG = 1.5;
const TENTACLE_FAR = 16;
/** Path seed: the same flight every time the visualizer starts. */
const SEED = 0x1a77;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/lattice/";
  const [vs, fs, cfs] = await Promise.all(
    ["fullscreen.vert", "lattice.frag", "composite.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const tentacle = isTentacle(ctx.id);
  const src = tentacle ? fs.replace("#version 300 es\n", "#version 300 es\n#define TENTACLE\n") : fs;
  const prog = createProgram(gl, vs, src, dir + "lattice.frag");
  const comp = createProgram(gl, vs, cfs, dir + "composite.frag");
  const u = prog.u;
  const vao = gl.createVertexArray();
  const scene = createTarget(gl);

  const hist = createFaceHistory(HIST_W, HIST_N);
  const histTex = /** @type {WebGLTexture} */ (gl.createTexture());
  gl.bindTexture(gl.TEXTURE_2D, histTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, HIST_W, HIST_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(HIST_W * HIST_N * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  const beat = createBeat();
  const cam = createCamera(SEED);
  const pulses = createPulses();
  const axis = createAxisLight();
  const beatIn = { bpm: 0, beatPhase: 0, onset: false, onsetStrength: 0 };
  const pal = new Float32Array(PALETTE_FLOATS);
  const geo = new Float32Array(3);
  const origin = new Float64Array(3);
  const source = new Float64Array(3);
  let clock = 0;
  // Tentacle Lattice only.
  const sway = createSway();
  const swell = createSwell();
  const twists = createTwists(SEED);
  const materials = createMaterials();
  const motion = { sway: 1, twitch: 1 };
  let tg = tentacleGeometry(Number(ctx.params.length));
  paletteOf(ctx.params.palette, pal);
  geometry(Number(ctx.params.thickness), geo);

  function resize() {
    const s = qualityOf(ctx.params.quality).scale * (tentacle ? TENTACLE_SCALE : 1);
    const w = Math.max(1, Math.round(ctx.size.width * s));
    const h = Math.max(1, Math.round(ctx.size.height * s));
    if (w !== scene.width || h !== scene.height) scene.resize(w, h);
  }
  resize();

  return {
    frame(audio, time) {
      const dt = time.dt;
      const react = Math.max(0, Math.min(2, Number(ctx.params.reactivity)));
      // While the source is silent the tempo can linger: ignore it.
      const live = !audio.silent;
      beatIn.bpm = live ? audio.bpm : 0;
      beatIn.beatPhase = audio.beatPhase;
      beatIn.onset = live && audio.onset;
      beatIn.onsetStrength = audio.onsetStrength;
      beat.step(beatIn, dt);

      cam.update(dt, flySpeed(Number(ctx.params.speed), beat.env, react, ctx.reduceMotion));
      if (beat.beat && react > 0) {
        const level = beatIn.bpm > 0 ? 1 : Math.min(1, audio.onsetStrength);
        const period = beatIn.bpm > 0 ? 60 / beatIn.bpm : 0.5;
        cam.ahead(SOURCE_AHEAD, source);
        pulses.launch(source, level * react, ctx.reduceFlashing, period, motionScale(ctx.reduceMotion));
        if (tentacle) twists.kick(source, motionParams(ctx.params, ctx.reduceMotion, motion).twitch, ctx.reduceMotion);
      }
      for (let c = 0; c < 3; c++) origin[c] = Math.floor(cam.pos[c]);
      pulses.step(dt, origin);
      axis.step(audio.bands, dt, react, ctx.reduceFlashing);
      clock += dt * motionScale(ctx.reduceMotion);

      // One history row per frame.
      const row = hist.push(audio.bands, audio.waveform, live ? react : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, histTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, HIST_W, 1, gl.RGBA, gl.UNSIGNED_BYTE, hist.row);

      const q = qualityOf(ctx.params.quality);
      // The creatures fill the view far more than rods: thicker fog keeps it legible (and the
      // march short).
      const fog = fogDensity(Number(ctx.params.fog)) * (tentacle ? TENTACLE_FOG : 1);
      const v = cam.view;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // 1. Raymarch at reduced resolution (linear, premultiplied).
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, scene.width, scene.height);
      gl.useProgram(prog.program);
      gl.uniform2f(u.u_res, scene.width, scene.height);
      gl.uniform3f(u.u_cam, cam.pos[0] - origin[0], cam.pos[1] - origin[1], cam.pos[2] - origin[2]);
      gl.uniform3f(u.u_fwd, v.fwd[0], v.fwd[1], v.fwd[2]);
      gl.uniform3f(u.u_up, v.up[0], v.up[1], v.up[2]);
      gl.uniform3f(u.u_right, v.right[0], v.right[1], v.right[2]);
      gl.uniform1f(u.u_tanHalf, Math.tan(FOV / 2));
      gl.uniform3f(u.u_geo, geo[0], geo[1], geo[2]);
      gl.uniform1f(u.u_fog, fog);
      gl.uniform1f(u.u_far, Math.min(tentacle ? TENTACLE_FAR : MAX_FAR, -Math.log(FOG_CUTOFF) / fog));
      // The tentacles leave narrower channels than the rods, so rays take smaller steps.
      gl.uniform1i(u.u_steps, tentacle ? Math.round(q.steps * TENTACLE_STEPS) : q.steps);
      gl.uniform3f(u.u_bg, pal[0], pal[1], pal[2]);
      gl.uniform3f(u.u_surf, pal[3], pal[4], pal[5]);
      gl.uniform3f(u.u_ax, pal[6], pal[7], pal[8]);
      gl.uniform3f(u.u_ay, pal[9], pal[10], pal[11]);
      gl.uniform3f(u.u_az, pal[12], pal[13], pal[14]);
      gl.uniform3f(u.u_glow, pal[15], pal[16], pal[17]);
      gl.uniform1f(u.u_ink, pal[18]);
      gl.uniform1f(u.u_bgA, ctx.params.background === "none" ? 0 : 1);
      gl.uniform3f(u.u_light, axis.light[0], axis.light[1], axis.light[2]);
      gl.uniform1f(u.u_time, clock);
      gl.uniform4fv(u.u_pulse, pulses.data);
      gl.uniform1fv(u.u_pamp, pulses.amp);
      gl.uniform1i(u.u_hist, 0);
      gl.uniform1f(u.u_head, hist.head);
      gl.uniform1f(u.u_rows, HIST_N);
      if (tentacle) {
        motionParams(ctx.params, ctx.reduceMotion, motion);
        sway.step(audio.bands, dt, motion.sway, react, ctx.reduceMotion);
        swell.step(live ? audio.bassAtt : 1, dt, react, ctx.reduceMotion);
        twists.step(dt, origin);
        const w = materials.step(dt, ctx.params.material, live ? audio.rms : 0, beatIn.bpm);
        const g = tg;
        gl.uniform4f(u.u_tg, g.reach, g.root, g.tip, g.half);
        gl.uniform3f(u.u_sway, sway.amp, sway.clock, sway.ripple);
        // Bound on how far any tentacle surface gets from its strut's axis.
        gl.uniform1f(u.u_env, envelopeMax(g, sway.amp));
        gl.uniform1f(u.u_swell, swell.value);
        gl.uniform4fv(u.u_twist, twists.data);
        gl.uniform1fv(u.u_taxis, twists.axis);
        gl.uniform4f(u.u_mat, w[0], w[1], w[2], w[3]);
        gl.uniform3f(u.u_origin, origin[0], origin[1], origin[2]);
        gl.uniform1f(u.u_shake, motionScale(ctx.reduceMotion));
        gl.uniform4fv(u.u_live, pulses.live);
        gl.uniform1fv(u.u_liveAmp, pulses.liveAmp);
        gl.uniform1i(u.u_np, pulses.liveCount);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. Upsample onto the transparent canvas as premultiplied sRGB.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(comp.program);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(comp.u.u_scene, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    resize,

    params(changed) {
      if ("palette" in changed) paletteOf(ctx.params.palette, pal);
      if ("thickness" in changed) geometry(Number(ctx.params.thickness), geo);
      if ("length" in changed) tg = tentacleGeometry(Number(ctx.params.length));
      if ("quality" in changed) resize();
    },

    pointer(e) {
      cam.pointer(e);
    },

    dispose() {
      scene.dispose();
      gl.deleteTexture(histTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(comp.program);
    },
  };
}
