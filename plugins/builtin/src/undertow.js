// @ts-check
/**
 * Undertow — MilkDrop-style feedback warp for the `webgl2` renderer.
 *
 * Each frame: (1) warp last frame's image (zoom/rotate/ripple driven by bassAtt/midAtt/trebAtt and
 * beatPhase) into the other of two ping-pong framebuffers, with decay; (2) add this frame's
 * waveform rings or band spikes on top; (3) tone-map that buffer to the screen.
 *
 * Shaders live in shaders/undertow/ and load with ctx.assets.text. The waveform and bands reach the
 * GPU as one 512×2 float texture updated in place, so the frame loop allocates nothing.
 */
import { hexToRgb } from "./lib/color.js";
import { createFlashLimiter } from "./lib/flash.js";
import { createProgram, createTarget } from "./lib/gl.js";

const RING_VERTS = 2 * 256 * 6;
const BAR_VERTS = 128 * 6;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/undertow/";
  const [fullVs, warpFs, waveVs, waveFs, compFs] = await Promise.all(
    ["fullscreen.vert", "warp.frag", "wave.vert", "wave.frag", "composite.frag"].map((f) =>
      ctx.assets.text(dir + f),
    ),
  );
  const warp = createProgram(gl, fullVs, warpFs, dir + "warp.frag");
  const wave = createProgram(gl, waveVs, waveFs, dir + "wave.frag");
  const comp = createProgram(gl, fullVs, compFs, dir + "composite.frag");

  const vao = gl.createVertexArray(); // attribute-less drawing still wants a bound VAO
  const targets = [createTarget(gl), createTarget(gl)];
  let cur = 0;

  const audioTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, audioTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 512, 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const tint = new Float32Array(3);
  const lineColor = new Float32Array(3);
  const flash = createFlashLimiter();
  let kick = 0;
  let clock = 0;

  function applyParams() {
    hexToRgb(ctx.params.tint, tint);
    // Lines are a whiter version of the tint so they read against their own trails.
    for (let i = 0; i < 3; i++) lineColor[i] = 0.2 + 0.8 * tint[i];
  }

  function resize() {
    for (const t of targets) t.resize(ctx.size.width, ctx.size.height);
  }

  applyParams();
  resize();

  return {
    frame(audio, time) {
      const { width: w, height: h } = ctx.size;
      const speed = Number(ctx.params.speed);
      const k = time.dt * 60; // per-60 Hz-frame quantities scale by this
      clock += time.dt * speed;

      kick = audio.onset ? Math.min(1, 0.5 + audio.onsetStrength) : kick * Math.exp(-time.dt * 6);
      const pulse = flash.step(kick, time.dt, ctx.reduceFlashing);
      const beat = audio.bpm > 0 ? (1 - audio.beatPhase) ** 3 : 0;

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);

      // Audio → texture (zero-copy views straight into texSubImage2D).
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, audioTex);
      // Newest 512 samples; srcOffset avoids a subarray allocation per frame.
      const samples = audio.waveform;
      const newest = Math.max(0, samples.length - 512);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED, gl.FLOAT, samples, newest);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, 64, 1, gl.RED, gl.FLOAT, audio.bands);

      // 1. Warp previous frame into the other target.
      const src = targets[cur];
      const dst = targets[cur ^ 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.width, dst.height);
      gl.useProgram(warp.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(warp.u.u_prev, 0);
      gl.uniform2f(warp.u.u_res, dst.width, dst.height);
      gl.uniform1f(warp.u.u_time, clock);
      gl.uniform1f(warp.u.u_zoom, 1 - (0.004 + 0.007 * audio.bassAtt + 0.006 * beat) * speed * k);
      gl.uniform1f(warp.u.u_rot, (0.004 * Math.sin(clock * 0.23) + 0.0015 * audio.midAtt) * speed * k);
      gl.uniform1f(warp.u.u_warp, 0.5 + audio.midAtt);
      gl.uniform1f(warp.u.u_decay, (0.955 - 0.01 * Math.min(2, audio.trebAtt)) ** k);
      gl.uniform1f(warp.u.u_mirror, ctx.params.mirror ? 1 : 0);
      gl.uniform3fv(warp.u.u_tint, tint);
      gl.uniform1f(warp.u.u_hue, (0.006 + 0.01 * audio.trebAtt) * speed * k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. Inject this frame's shapes additively.
      const bars = ctx.params.mode === "bars";
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(wave.program);
      gl.uniform1i(wave.u.u_audio, 1);
      gl.uniform2f(wave.u.u_res, dst.width, dst.height);
      gl.uniform1f(wave.u.u_mode, bars ? 1 : 0);
      gl.uniform1f(wave.u.u_radius, 0.3 + 0.04 * beat + 0.03 * audio.bassAtt);
      gl.uniform1f(wave.u.u_thick, (bars ? 4 : 5) * (h / 1440) * (1 + 0.5 * pulse));
      gl.uniform1f(wave.u.u_time, clock);
      gl.uniform3fv(wave.u.u_color, lineColor);
      gl.uniform1f(wave.u.u_gain, (bars ? 0.35 : 1) * (0.22 + 0.25 * audio.rms + 0.25 * pulse));
      gl.drawArrays(gl.TRIANGLES, 0, bars ? BAR_VERTS : RING_VERTS);
      gl.disable(gl.BLEND);

      // 3. Composite to the canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(comp.program);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(comp.u.u_src, 0);
      gl.uniform1f(comp.u.u_exposure, 1.6 + 0.8 * pulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      cur ^= 1;
    },

    resize,

    params() {
      applyParams();
    },

    dispose() {
      for (const t of targets) t.dispose();
      gl.deleteTexture(audioTex);
      gl.deleteVertexArray(vao);
      for (const p of [warp, wave, comp]) gl.deleteProgram(p.program);
    },
  };
}
