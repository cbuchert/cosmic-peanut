// @ts-check
/**
 * Tetraballs — four metaballs at the corners of a slowly tumbling tetrahedron, fused into one
 * liquid blob and raymarched in a full-screen shader, in a choice of materials (or `auto`, which
 * moves on every few bars with a one-second crossfade).
 *
 * The waveform drives it: each audio frame's newest samples are split into four consecutive
 * quarters, one per ball. A ball's radius follows its quarter's energy (RMS, auto-gained, with
 * attack/release) and its distance from the centroid follows its quarter's transients through an
 * underdamped spring, so hits burst the shape apart into droplets and the springs pull it back
 * together through liquid bridges. Beats kick the tumble.
 *
 * Passes: a full-resolution surface pass (backdrop + sphere-traced blob, bounded by the blob's
 * bounding sphere) and, for fire and smoke, a reduced-resolution volume pass composited on top.
 * Pure logic lives in lib/tetra-motion.js, lib/metaball.js and lib/tetra-material.js (tested).
 * Nothing is allocated per frame.
 */
import { hexToRgb } from "./lib/color.js";
import { createFlashLimiter } from "./lib/flash.js";
import { createProgram, createTarget } from "./lib/gl.js";
import { boundRadius } from "./lib/metaball.js";
import { createIntensity, createSequencer, MATERIALS, VOLUMETRIC } from "./lib/tetra-material.js";
import { createBalls, createTumble, effectiveMotion, tetraVertices } from "./lib/tetra-motion.js";

/** Smooth-min blend width at Size 1 (bridges form below bridgeDistance(r, K)). */
const K = 0.5;
/** Raymarch budgets and volume-pass resolution per Quality. */
const QUALITY = {
  low: { steps: 56, vsteps: 44, vscale: 0.4 },
  medium: { steps: 88, vsteps: 56, vscale: 0.5 },
  high: { steps: 128, vsteps: 88, vscale: 0.6 },
};
const FIRE = MATERIALS.indexOf("fire");
const SMOKE = MATERIALS.indexOf("smoke");

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/tetraballs/";
  const [vs, common, materials, surface, volume, composite] = await Promise.all(
    ["fullscreen.vert", "common.glsl", "materials.glsl", "surface.glsl", "volume.glsl", "composite.frag"].map((f) =>
      ctx.assets.text(dir + f),
    ),
  );
  const head = "#version 300 es\n";
  const surf = createProgram(gl, vs, head + common + materials + surface, dir + "surface.glsl");
  const vol = createProgram(gl, vs, head + common + volume, dir + "volume.glsl");
  const comp = createProgram(gl, vs, composite, dir + "composite.frag");
  const vao = gl.createVertexArray();
  const target = createTarget(gl);

  const verts = tetraVertices(new Float32Array(12));
  const balls = createBalls();
  const tumble = createTumble();
  const seq = createSequencer();
  const light = createIntensity();
  const fadeGuard = createFlashLimiter(3);
  const motion = { tumble: 0, bounce: 0 };
  const rot = new Float32Array(9);
  const ball = new Float32Array(16);
  const tint = new Float32Array(3);
  const bound = new Float32Array(4);
  readTint();

  function quality() {
    const q = /** @type {keyof typeof QUALITY} */ (String(ctx.params.quality));
    return QUALITY[q] ?? QUALITY.medium;
  }

  function readTint() {
    hexToRgb(ctx.params.tint, tint);
    for (let i = 0; i < 3; i++) tint[i] *= tint[i]; // ≈ sRGB → linear
  }

  function sizeTarget() {
    const s = quality().vscale;
    const w = Math.max(1, Math.ceil(ctx.size.width * s));
    const h = Math.max(1, Math.ceil(ctx.size.height * s));
    if (w !== target.width || h !== target.height) target.resize(w, h);
  }

  /**
   * Uniforms both scene passes share.
   * @param {Record<string, WebGLUniformLocation | null>} u
   * @param {number} w @param {number} h @param {number} now @param {number} lightNow
   */
  function sceneUniforms(u, w, h, now, lightNow) {
    gl.uniform2f(u.u_res, w, h);
    gl.uniform4fv(u.u_ball, ball);
    gl.uniform1f(u.u_k, K * Number(ctx.params.size));
    gl.uniform4f(u.u_bound, bound[0], bound[1], bound[2], bound[3]);
    gl.uniform1i(u.u_steps, quality().steps);
    gl.uniform1f(u.u_time, now);
    gl.uniform1f(u.u_bgA, ctx.params.background === "none" ? 0 : 1);
    gl.uniform1f(u.u_light, lightNow);
    gl.uniform3f(u.u_axis, rot[3], rot[4], rot[5]);
    gl.uniform3f(u.u_tint, tint[0], tint[1], tint[2]);
  }

  return {
    frame(audio, time) {
      const dt = time.dt;
      const size = Number(ctx.params.size);
      effectiveMotion(Number(ctx.params.tumble), Number(ctx.params.bounce), ctx.reduceMotion, motion);
      const react = Number(ctx.params.reactivity);
      balls.step(audio.waveform, dt, react, motion.bounce, audio.onset, audio.onsetStrength);
      const kick = ctx.reduceMotion ? 0.35 : 1;
      tumble.step(dt, motion.tumble, audio.onset && react > 0, audio.onsetStrength * kick);
      tumble.matrix(rot);

      // Ball centres: tetrahedron vertex × its distance, turned by the tumble, × Size.
      let maxD = 0;
      let maxR = 0;
      for (let i = 0; i < 4; i++) {
        const x = verts[i * 3];
        const y = verts[i * 3 + 1];
        const z = verts[i * 3 + 2];
        const s = balls.dist[i] * size;
        ball[i * 4] = (rot[0] * x + rot[3] * y + rot[6] * z) * s;
        ball[i * 4 + 1] = (rot[1] * x + rot[4] * y + rot[7] * z) * s;
        ball[i * 4 + 2] = (rot[2] * x + rot[5] * y + rot[8] * z) * s;
        ball[i * 4 + 3] = balls.radius[i] * size;
        if (balls.dist[i] > maxD) maxD = balls.dist[i];
        if (balls.radius[i] > maxR) maxR = balls.radius[i];
      }
      bound[3] = boundRadius(maxD * size, maxR * size, K * size);

      seq.step(String(ctx.params.material), dt, audio.bpm, audio.rms);
      const mix = fadeGuard.step(seq.mix, dt, ctx.reduceFlashing);
      const lightNow = light.step(audio.onset, audio.onsetStrength, audio.rms, dt, ctx.reduceFlashing);
      const volA = VOLUMETRIC[seq.a];
      const volB = VOLUMETRIC[seq.b];
      const { width: w, height: h } = ctx.size;

      // Surface pass (always: it also paints or clears the backdrop).
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(vao);
      gl.useProgram(surf.program);
      const u = surf.u;
      sceneUniforms(u, w, h, time.now, lightNow);
      gl.uniform1i(u.u_matA, seq.a);
      gl.uniform1i(u.u_matB, seq.b);
      gl.uniform1f(u.u_mix, mix);
      gl.uniform1f(u.u_fade, volA && volB ? 0 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (volA || volB) {
        sizeTarget();
        const fire = (seq.a === FIRE ? 1 - mix : 0) + (seq.b === FIRE && seq.b !== seq.a ? mix : 0);
        const smoke = (seq.a === SMOKE ? 1 - mix : 0) + (seq.b === SMOKE && seq.b !== seq.a ? mix : 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(vol.program);
        const v = vol.u;
        sceneUniforms(v, target.width, target.height, time.now, lightNow);
        // Flames and smoke rise: march a larger sphere, raised above the blob.
        const r = bound[3];
        gl.uniform4f(v.u_vbound, 0, r * 0.55, 0, r * 1.65);
        gl.uniform1f(v.u_fire, fire);
        gl.uniform1f(v.u_smoke, smoke);
        gl.uniform1i(v.u_vsteps, quality().vsteps);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(comp.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.uniform1i(comp.u.u_vol, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.BLEND);
      }
    },

    params(changed) {
      if ("tint" in changed) readTint();
    },

    dispose() {
      target.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(surf.program);
      gl.deleteProgram(vol.program);
      gl.deleteProgram(comp.program);
    },
  };
}
