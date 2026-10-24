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
 * pulse topology, a clearance check and a small runtime. Lattice's Structure param picks
 * "cubic" (the default), the strut lattices "octet", "diamond" and "bitruncated"
 * (lib/strut-camera.js), "sponge" (an endless Menger zoom) or "kaleidoscope" (a KIFS cathedral);
 * Tentacle Lattice (`ctx.id` "tentacle-lattice") is fixed to "tentacle": six
 * swaying, tapered tentacles per node, materials crossfading (shade.glsl MATERIALS), handshakes
 * along each beat pulse, a quarter-turn twist at its node and a local bass swell. "gyroid",
 * "schwarz-p" and "schwarz-d" are triply periodic minimal surfaces (lib/tpms.js) with their own
 * camera through one labyrinth (lib/net-camera.js); switching to a structure with a different
 * camera provider restarts the flight there (and one with another pulse topology, its pulses).
 *
 * Look (lib/lattice-look.js; shaders/lattice/README.md → "Shading"): classic is the original
 * shading, byte for byte; cinematic compiles the scene with brdf.glsl and CINEMATIC (physically
 * based materials, pulse tube lights packed by lib/lattice-lights.js, analytic fog in-scatter,
 * soft shadows), then runs the bloom chain (lib/lattice-bloom.js) and tone-maps in post.frag.
 *
 * Everything per frame writes into preallocated arrays: frame() allocates nothing.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import { createBeat } from "./lib/lattice-beat.js";
import { createBloom } from "./lib/lattice-bloom.js";
import { createFaceHistory } from "./lib/lattice-history.js";
import { REDUCED_LIGHT, createLightPack, packPulseLights } from "./lib/lattice-lights.js";
import {
  MATERIAL_FLOATS,
  lookDefines,
  lookOf,
  paletteMaterial,
  shadingSamples,
  toneInverse,
} from "./lib/lattice-look.js";
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
import { STRUCTURES, assembleShader, pulseLightsOf, structureFor } from "./lib/structures.js";

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
/** Cinematic: pulse lights are packed by distance from the point this far ahead of the camera. */
const LIGHT_FOCUS = 1.5;
/** Cinematic: the bloom mix (Jimenez 2014's small lerp), and its share on paper (ink). */
const BLOOM_MIX = 0.06;
const BLOOM_INK = 0.25;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/lattice/";
  const [vs, main, cfs, bfs, brdf, ...parts] = await Promise.all(
    ["fullscreen.vert", "lattice.frag", "post.frag", "bloom.frag", "brdf.glsl", ...PARTS.map((n) => n + ".glsl")].map(
      (f) => ctx.assets.text(dir + f),
    ),
  );
  /** @type {Record<string, string>} */
  const shared = {};
  PARTS.forEach((n, i) => (shared[n] = parts[i]));

  /**
   * Compile the scene program for a structure and Look (classic: the original text; cinematic:
   * brdf.glsl ahead of shade.glsl, and CINEMATIC defined).
   * @param {import('./lib/structures.js').Structure} st @param {string} lk
   */
  async function sceneProgram(st, lk) {
    const structure = await ctx.assets.text(dir + st.shader);
    const cine = lk === "cinematic";
    const shade = cine ? brdf + "\n" + shared.shade : shared.shade;
    const src = assembleShader(main, { ...shared, shade, structure }, [...st.defines, ...lookDefines(lk)]);
    return createProgram(gl, vs, src, dir + "lattice.frag + " + st.shader);
  }

  let structureName = structureFor(ctx.id, ctx.params.structure);
  let structure = STRUCTURES[structureName];
  let look = lookOf(ctx.params.look);
  let prog = await sceneProgram(structure, look);
  let runtime = structure.runtime(ctx);
  const comp = createProgram(gl, vs, cfs, dir + "post.frag");
  /** The cinematic look's composite and bloom programs, compiled the first time it is used. */
  /** @type {{ comp: ReturnType<typeof createProgram>, bloom: import('./lib/lattice-bloom.js').BloomPrograms } | null} */
  let cine = null;
  const cineProgs = () =>
    (cine ??= {
      comp: createProgram(gl, vs, assembleShader(cfs, {}, ["CINEMATIC"]), dir + "post.frag (cinematic)"),
      bloom: {
        karis: createProgram(gl, vs, assembleShader(bfs, {}, ["KARIS"]), dir + "bloom.frag (karis)"),
        down: createProgram(gl, vs, bfs, dir + "bloom.frag"),
        up: createProgram(gl, vs, assembleShader(bfs, {}, ["UP"]), dir + "bloom.frag (up)"),
      },
    });
  const bloom = createBloom(gl);
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
  // The current structure's pulse pool; a structure with another pulse topology gets its own.
  let pulses = createPulses(structure.pulseSource);
  const axis = createAxisLight();
  const beatIn = { bpm: 0, beatPhase: 0, onset: false, onsetStrength: 0 };
  const pal = new Float32Array(PALETTE_FLOATS);
  const mat = new Float32Array(MATERIAL_FLOATS);
  const fogCol = new Float32Array(3);
  const lights = createLightPack();
  const origin = new Float64Array(3);
  const source = new Float64Array(3);
  /** @type {import('./lib/structures.js').StructureFrame} */
  const sf = { react: 0, live: true, bpm: 0, origin, pulses, cam };
  let clock = 0;
  /** The palette and its cinematic material, and the background as HDR (its tone inverse). */
  function palette() {
    paletteOf(ctx.params.palette, pal);
    paletteMaterial(ctx.params.palette, mat);
    for (let c = 0; c < 3; c++) fogCol[c] = toneInverse(pal[c]);
  }
  palette();

  function resize() {
    const s = qualityOf(ctx.params.quality).scale * structure.scale;
    const w = Math.max(1, Math.round(ctx.size.width * s));
    const h = Math.max(1, Math.round(ctx.size.height * s));
    if (w !== scene.width || h !== scene.height) scene.resize(w, h);
    if (look === "cinematic") bloom.resize(scene.width, scene.height);
  }
  resize();
  /** Scene-program rebuilds requested (params): a stale one is dropped when it lands. */
  let building = 0;

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
      const cinematic = look === "cinematic";
      if (cinematic) {
        // The pulses' tube lights nearest the view, the palette's material, sample counts.
        const f = cam.view.fwd;
        const fx = cam.pos[0] - origin[0] + f[0] * LIGHT_FOCUS;
        const fy = cam.pos[1] - origin[1] + f[1] * LIGHT_FOCUS;
        const fz = cam.pos[2] - origin[2] + f[2] * LIGHT_FOCUS;
        packPulseLights(lights, pulses, fx, fy, fz, pulseLightsOf(structure), ctx.reduceFlashing ? REDUCED_LIGHT : 1);
        gl.uniform4fv(u.u_ltA, lights.a);
        gl.uniform4fv(u.u_ltB, lights.b);
        gl.uniform1i(u.u_nl, lights.count);
        const n = shadingSamples(ctx.params.quality);
        gl.uniform1i(u.u_shSteps, n.shadow);
        gl.uniform1i(u.u_aoN, n.ao);
        gl.uniform3f(u.u_fogCol, fogCol[0], fogCol[1], fogCol[2]);
        gl.uniform3f(u.u_f0, mat[0], mat[1], mat[2]);
        gl.uniform2f(u.u_rm, mat[3], mat[4]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. Upsample onto the transparent canvas as premultiplied sRGB (cinematic: bloom, then
      // tone-map in the composite).
      if (cinematic) {
        const cp = cineProgs();
        bloom.render(scene.tex, scene.width, scene.height, cp.bloom, /** @type {WebGLVertexArrayObject} */ (vao));
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.size.width, ctx.size.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(cp.comp.program);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, bloom.tex);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, scene.tex);
        gl.uniform1i(cp.comp.u.u_scene, 0);
        gl.uniform1i(cp.comp.u.u_bloom, 1);
        gl.uniform1f(cp.comp.u.u_bloomN, bloom.levels);
        gl.uniform1f(cp.comp.u.u_bloomK, BLOOM_MIX * (1 - (1 - BLOOM_INK) * pal[18]));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return;
      }
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
      if ("palette" in changed) palette();
      runtime.params(changed);
      if ("quality" in changed) resize();
      const name = structureFor(ctx.id, ctx.params.structure);
      const lk = lookOf(ctx.params.look);
      if (name !== structureName || lk !== look) {
        // Swap the scene program (and, for a new structure, the runtime). The camera and pulses
        // carry on unless the new structure has its own camera provider or pulse topology (see
        // below). Only the latest request lands.
        const gen = ++building;
        sceneProgram(STRUCTURES[name], lk).then((next) => {
          if (gen !== building) {
            gl.deleteProgram(next.program);
            return;
          }
          gl.deleteProgram(prog.program);
          prog = next;
          if (name !== structureName) runtime = STRUCTURES[name].runtime(ctx);
          structureName = name;
          // A structure with its own free space brings its own camera path and pulse topology.
          if (STRUCTURES[name].camera !== structure.camera) sf.cam = cam = STRUCTURES[name].camera(SEED);
          if (STRUCTURES[name].pulseSource !== structure.pulseSource) {
            sf.pulses = pulses = createPulses(STRUCTURES[name].pulseSource);
          }
          structure = STRUCTURES[name];
          look = lk;
          resize();
        }, (err) => ctx.log(String(err)));
      }
    },

    pointer(e) {
      cam.pointer(e);
    },

    dispose() {
      scene.dispose();
      bloom.dispose();
      if (cine) {
        for (const p of [cine.comp, cine.bloom.karis, cine.bloom.down, cine.bloom.up]) gl.deleteProgram(p.program);
      }
      gl.deleteTexture(histTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(comp.program);
    },
  };
}
