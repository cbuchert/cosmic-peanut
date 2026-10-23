// @ts-check
/**
 * Lattice — an endless cubic lattice, a rounded cube at every node joined by rods along the three
 * axes, that the camera flies through, for the `webgl2` renderer.
 *
 * Render: one full-screen raymarch at reduced scale (Quality; shaders/lattice/README.md) by
 * domain repetition over a cubic cell — exact distances, so it marches quickly down the empty
 * channels — with soft headlight + key lighting, five-sample ambient occlusion and exponential
 * fog to the palette's background (or to transparent, Background "none"). A full-resolution
 * composite (post.frag) upsamples it to premultiplied sRGB.
 *
 * Motion (lib/lattice-camera.js): the camera flies a walk through the free channels between the
 * rods (cell centre to cell centre), whose turns are decided on beats and placed ahead of the view,
 * smoothed by a cubic B-spline; the speed and the view turn through critically damped springs
 * (integrated in short substeps), so beats push and steer it gently. Drag to look around; it eases
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
 * Structures (lib/structures.js; shaders/lattice/README.md is the contract): what the camera flies
 * through is pluggable — a GLSL scene SDF + surface parameterization, a camera path provider, a
 * pulse topology, a clearance check and a small runtime. "cubic" is Lattice's (the Structure
 * param picks it); Tentacle Lattice (`ctx.id` "tentacle-lattice") is fixed to "tentacle": six
 * swaying, tapered tentacles per node, materials crossfading (shade.glsl MATERIALS), handshakes
 * along each beat pulse, a quarter-turn twist at its node and a local bass swell.
 *
 * Everything per frame writes into preallocated arrays: frame() allocates nothing.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import { createBeat } from "./lib/lattice-beat.js";
import { createFaceHistory } from "./lib/lattice-history.js";
import { createPulses } from "./lib/lattice-pulses.js";
import {
  PALETTE_FLOATS,
  createAxisLight,
  flySpeed,
  fogDensity,
  motionScale,
  paletteOf,
  qualityOf,
} from "./lib/lattice.js";
import { STRUCTURES, assembleShader, structureFor } from "./lib/structures.js";

/** Vertical field of view (radians). */
const FOV = (68 * Math.PI) / 180;
/** Beat pulses launch from the node nearest the path this many cells ahead of the camera. */
const SOURCE_AHEAD = 1.6;
/** History ring: texels per row (bands) and rows. */
const HIST_W = 64;
const HIST_N = 256;
/** The march stops where the fog leaves under this much of a surface (or at the structure's far). */
const FOG_CUTOFF = 0.02;
/** The scene shader's parts, joined by assembleShader at `// #include <name>`. */
const PARTS = ["common", "march", "shade"];
/** Path seed: the same flight every time the visualizer starts. */
const SEED = 0x1a77;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/lattice/";
  const [vs, main, cfs, ...parts] = await Promise.all(
    ["fullscreen.vert", "lattice.frag", "post.frag", ...PARTS.map((n) => n + ".glsl")].map((f) =>
      ctx.assets.text(dir + f),
    ),
  );
  /** @type {Record<string, string>} */
  const shared = {};
  PARTS.forEach((n, i) => (shared[n] = parts[i]));

  /** Compile the scene program for a structure. @param {import('./lib/structures.js').Structure} st */
  async function sceneProgram(st) {
    const structure = await ctx.assets.text(dir + st.shader);
    const src = assembleShader(main, { ...shared, structure }, st.defines);
    return createProgram(gl, vs, src, dir + "lattice.frag + " + st.shader);
  }

  let structureName = structureFor(ctx.id, ctx.params.structure);
  let structure = STRUCTURES[structureName];
  let prog = await sceneProgram(structure);
  let runtime = structure.runtime(ctx);
  const comp = createProgram(gl, vs, cfs, dir + "post.frag");
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
  let cam = structure.camera(SEED);
  let pulses = createPulses(structure.pulseSource);
  const axis = createAxisLight();
  const beatIn = { bpm: 0, beatPhase: 0, onset: false, onsetStrength: 0 };
  const pal = new Float32Array(PALETTE_FLOATS);
  const origin = new Float64Array(3);
  const source = new Float64Array(3);
  /** @type {import('./lib/structures.js').StructureFrame} */
  const sf = { react: 0, live: true, bpm: 0, origin, pulses, cam };
  let clock = 0;
  paletteOf(ctx.params.palette, pal);

  function resize() {
    const s = qualityOf(ctx.params.quality).scale * structure.scale;
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

      // The beat picks the next turn (placed beyond the view, so the path stays smooth).
      if (beat.beat) cam.beat();
      cam.update(dt, flySpeed(Number(ctx.params.speed), beat.env, react, ctx.reduceMotion));
      if (beat.beat && react > 0) {
        const level = beatIn.bpm > 0 ? 1 : Math.min(1, audio.onsetStrength);
        const period = beatIn.bpm > 0 ? 60 / beatIn.bpm : 0.5;
        cam.ahead(SOURCE_AHEAD, source);
        pulses.launch(source, level * react, ctx.reduceFlashing, period, motionScale(ctx.reduceMotion));
        runtime.onBeat(source);
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
      const fog = fogDensity(Number(ctx.params.fog)) * structure.fog;
      const v = cam.view;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // 1. Raymarch at reduced resolution (linear, premultiplied).
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, scene.width, scene.height);
      const u = prog.u;
      gl.useProgram(prog.program);
      gl.uniform2f(u.u_res, scene.width, scene.height);
      gl.uniform3f(u.u_cam, cam.pos[0] - origin[0], cam.pos[1] - origin[1], cam.pos[2] - origin[2]);
      gl.uniform3f(u.u_fwd, v.fwd[0], v.fwd[1], v.fwd[2]);
      gl.uniform3f(u.u_up, v.up[0], v.up[1], v.up[2]);
      gl.uniform3f(u.u_right, v.right[0], v.right[1], v.right[2]);
      gl.uniform1f(u.u_tanHalf, Math.tan(FOV / 2));
      gl.uniform1f(u.u_fog, fog);
      gl.uniform1f(u.u_far, Math.min(structure.far, -Math.log(FOG_CUTOFF) / fog));
      gl.uniform1i(u.u_steps, Math.round(q.steps * structure.steps));
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
      gl.uniform3f(u.u_origin, origin[0], origin[1], origin[2]);
      gl.uniform4fv(u.u_live, pulses.live);
      gl.uniform1fv(u.u_liveAmp, pulses.liveAmp);
      gl.uniform1i(u.u_np, pulses.liveCount);
      sf.react = react;
      sf.live = live;
      sf.bpm = beatIn.bpm;
      runtime.step(audio, dt, sf);
      runtime.upload(gl, u, sf);
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
      runtime.params(changed);
      if ("quality" in changed) resize();
      if ("structure" in changed && structureFor(ctx.id, ctx.params.structure) !== structureName) {
        // Swap the scene program and runtime (the camera and pulses carry on).
        const name = structureFor(ctx.id, ctx.params.structure);
        sceneProgram(STRUCTURES[name]).then((next) => {
          gl.deleteProgram(prog.program);
          prog = next;
          structureName = name;
          // A structure with its own free space brings its own camera path and pulse topology.
          if (STRUCTURES[name].camera !== structure.camera) sf.cam = cam = STRUCTURES[name].camera(SEED);
          if (STRUCTURES[name].pulseSource !== structure.pulseSource) {
            sf.pulses = pulses = createPulses(STRUCTURES[name].pulseSource);
          }
          structure = STRUCTURES[name];
          runtime = structure.runtime(ctx);
          resize();
        }, (err) => ctx.log(String(err)));
      }
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
