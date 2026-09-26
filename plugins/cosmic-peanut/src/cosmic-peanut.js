// @ts-check
/**
 * Cosmic Peanut — each moment's waveform becomes a ring on an invisible sphere; rings drift from
 * the north pole to the south pole while the camera slowly orbits. `webgl2` renderer.
 *
 * All geometry is computed on the GPU from a static (j, i) vertex grid and an M × N R32F history
 * texture used as a circular buffer, so a frame is a few uniforms, at most a few one-row uploads,
 * and one drawElements call (plus a blit in Soft lines mode). The logic lives in ./lib (pure,
 * tested); this file is the GL glue. frame() allocates nothing.
 */
import { cameraDistance, createCamera, RADIUS } from "./lib/camera.js";
import { buildGrid } from "./lib/geometry.js";
import { createProgram } from "./lib/gl.js";
import { createHistory } from "./lib/history.js";
import { GENTLE, gentle } from "./lib/motion.js";
import { densityRings, paletteIndex, ringGain } from "./lib/params.js";
import { createPulse } from "./lib/pulse.js";

/** Points per ring: high, so the waveform stays jagged. */
const M = 512;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const [ringVs, ringFs, blitVs, blitFs, manifest] = await Promise.all([
    ctx.assets.text("shaders/rings.vert"),
    ctx.assets.text("shaders/rings.frag"),
    ctx.assets.text("shaders/blit.vert"),
    ctx.assets.text("shaders/blit.frag"),
    ctx.assets.json("tidalviz.json"),
  ]);
  // Manifest defaults decide whether the user has touched Orbit speed / Bass pulse (reduced motion).
  const specs = /** @type {import('../tidalviz').Manifest} */ (manifest).visualizers[0].params ?? [];
  /** @param {string} id */
  const defaultOf = (id) => Number(specs.find((p) => p.id === id)?.default);
  const orbitDefault = defaultOf("orbit");
  const pulseDefault = defaultOf("pulse");

  const rings = createProgram(gl, ringVs, ringFs, "shaders/rings");
  const blit = createProgram(gl, blitVs, blitFs, "shaders/blit");
  const U = rings.u;

  const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const blitVao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const hist = gl.createTexture();
  let indexCount = 0;

  const history = createHistory(M, densityRings(ctx.params.density), (row, ring) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, M, 1, gl.RED, gl.FLOAT, ring);
  });
  const camera = createCamera();
  const pulse = createPulse();

  /** Build the grid and a sentinel-filled history texture for the current density. */
  function allocate() {
    const { verts, indices } = buildGrid(history.N, M);
    indexCount = indices.length;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 0, 0); // read as float (j, i)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, hist);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, M, history.N, 0, gl.RED, gl.FLOAT, history.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  allocate();

  // Soft lines: rings go to a 1× (CSS-pixel) multisampled RGBA8 buffer (the prototype's canvas had
  // antialias on; the host's doesn't), resolve into a texture, then upscale linearly to the canvas.
  // 2× MSAA matches the prototype's smoothness side by side at ~20% less GPU time than 4×.
  // RGBA8 end to end: the rings' premultiplied alpha survives the resolve and the blit.
  const samples = Math.min(2, gl.getParameter(gl.MAX_SAMPLES));
  const msaaRb = gl.createRenderbuffer();
  const msaaFbo = gl.createFramebuffer();
  const softTex = gl.createTexture();
  const softFbo = gl.createFramebuffer();
  let softW = 0;
  let softH = 0;
  function resizeSoft() {
    const w = Math.max(1, Math.min(ctx.size.width, Math.round(ctx.size.cssWidth)));
    const h = Math.max(1, Math.min(ctx.size.height, Math.round(ctx.size.cssHeight)));
    if (w === softW && h === softH) return;
    softW = w;
    softH = h;
    gl.bindTexture(gl.TEXTURE_2D, softTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, softFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, softTex, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, msaaRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resizeSoft();

  return {
    frame(audio, time) {
      const p = ctx.params;
      const dt = time.dt;
      const orbit = gentle(Number(p.orbit), orbitDefault, ctx.reduceMotion, GENTLE.orbit);
      const strength = gentle(Number(p.pulse), pulseDefault, ctx.reduceMotion, GENTLE.pulse);
      const amp = Number(p.amp);
      const fine = p.lines === "fine";

      // Push the rings that are due (fixed rate), one texSubImage2D row each.
      gl.bindTexture(gl.TEXTURE_2D, hist);
      history.step(audio.waveform, dt, Number(p.travel), Number(p.detail));
      const pulseAmt = pulse.step(audio, dt) * strength;

      camera.update(dt, orbit);
      const { width, height } = ctx.size;
      const aspect = width / height;
      const dist = cameraDistance(amp, aspect);
      camera.writeMatrices(aspect, dist);

      if (fine) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
        gl.viewport(0, 0, softW, softH);
      }
      gl.clearColor(0, 0, 0, 0); // transparent canvas: the shell supplies black or the desktop
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive: overlapping rings glow
      gl.useProgram(rings.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(U.uHist, 0);
      gl.uniform1i(U.uHead, history.head);
      gl.uniform1i(U.uN, history.N);
      gl.uniform1i(U.uM, M);
      gl.uniform1f(U.uFrac, history.frac);
      gl.uniform1f(U.uAmp, amp);
      gl.uniform1f(U.uRadius, RADIUS);
      gl.uniform1f(U.uCamDist, dist);
      gl.uniform1f(U.uGain, ringGain(Number(p.bright), history.N, fine));
      gl.uniform1f(U.uPalette, paletteIndex(p.palette));
      gl.uniform1f(U.uPulse, pulseAmt);
      gl.uniformMatrix4fv(U.uProj, false, camera.proj);
      gl.uniformMatrix4fv(U.uView, false, camera.view);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.LINE_STRIP, indexCount, gl.UNSIGNED_INT, 0);
      gl.disable(gl.BLEND);

      if (!fine) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, softFbo);
        gl.blitFramebuffer(0, 0, softW, softH, 0, 0, softW, softH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(blit.program);
        gl.bindTexture(gl.TEXTURE_2D, softTex);
        gl.uniform1i(blit.u.uSrc, 0);
        gl.bindVertexArray(blitVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindVertexArray(null);
    },

    resize() {
      resizeSoft();
    },

    params(changed) {
      if ("density" in changed && history.setDensity(densityRings(changed.density))) allocate();
    },

    pointer(e) {
      camera.pointer(e);
    },

    dispose() {
      gl.deleteBuffer(vbo);
      gl.deleteBuffer(ibo);
      gl.deleteTexture(hist);
      gl.deleteTexture(softTex);
      gl.deleteFramebuffer(softFbo);
      gl.deleteFramebuffer(msaaFbo);
      gl.deleteRenderbuffer(msaaRb);
      gl.deleteVertexArray(vao);
      gl.deleteVertexArray(blitVao);
      gl.deleteProgram(rings.program);
      gl.deleteProgram(blit.program);
    },
  };
}
