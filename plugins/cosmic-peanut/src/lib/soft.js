// @ts-check
/**
 * Where the pack's lines are drawn (params.js `renderPath`). Fine lines go straight to the canvas.
 * Soft lines go to a 1× (CSS-pixel) RGBA8 buffer, 2× multisampled when Antialias is on (the
 * prototype's canvas had antialias on; the host's doesn't), resolved into a texture and upscaled
 * linearly to the canvas. 2× MSAA matches the prototype side by side at ~20% less GPU time than 4×.
 * RGBA8 end to end: the lines' premultiplied alpha survives the resolve and the blit. GL glue
 * shared by both entry modules; `begin` and `end` allocate nothing.
 */
import { createProgram } from "./gl.js";
import { renderPath } from "./params.js";

/**
 * @param {WebGL2RenderingContext} gl
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @param {string} blitVs shaders/blit.vert @param {string} blitFs shaders/blit.frag
 */
export function createSoftTarget(gl, ctx, blitVs, blitFs) {
  const blit = createProgram(gl, blitVs, blitFs, "shaders/blit");
  const blitVao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const samples = Math.min(2, gl.getParameter(gl.MAX_SAMPLES));
  const msaaRb = gl.createRenderbuffer();
  const msaaFbo = gl.createFramebuffer();
  const softTex = gl.createTexture();
  const softFbo = gl.createFramebuffer();
  let softW = 0;
  let softH = 0;
  let msaaOn = false;

  const target = {
    /** Size the buffers to the canvas and the Lines / Antialias params. Allocates; on change only. */
    resize() {
      const w = Math.max(1, Math.min(ctx.size.width, Math.round(ctx.size.cssWidth)));
      const h = Math.max(1, Math.min(ctx.size.height, Math.round(ctx.size.cssHeight)));
      const wantMsaa = renderPath(ctx.params.lines, ctx.params.antialias) === "msaa";
      if (w === softW && h === softH && wantMsaa === msaaOn) return;
      softW = w;
      softH = h;
      msaaOn = wantMsaa;
      gl.bindTexture(gl.TEXTURE_2D, softTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, softFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, softTex, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, msaaRb);
      // Antialias off (or fine lines): keep only a 1×1 placeholder so the MSAA memory is freed.
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, msaaOn ? w : 1, msaaOn ? h : 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaRb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    /**
     * Free the buffers while the cinematic look draws instead (it has its own target): 1×1
     * placeholders until the next `resize`. Allocates; Look changes only.
     */
    release() {
      softW = 0;
      softH = 0;
      gl.bindTexture(gl.TEXTURE_2D, softTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, msaaRb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, 1, 1);
    },
    /** Bind where this frame's lines go and clear it to transparent. @param {"canvas" | "msaa" | "soft"} path */
    begin(path) {
      if (path === "canvas") {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, path === "msaa" ? msaaFbo : softFbo);
        gl.viewport(0, 0, softW, softH);
      }
      gl.clearColor(0, 0, 0, 0); // transparent canvas: the shell supplies black or the desktop
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    /** Resolve and upscale soft lines onto the canvas (nothing for fine lines). @param {"canvas" | "msaa" | "soft"} path */
    end(path) {
      if (path === "canvas") return;
      if (path === "msaa") {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, softFbo);
        gl.blitFramebuffer(0, 0, softW, softH, 0, 0, softW, softH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      gl.useProgram(blit.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, softTex);
      gl.uniform1i(blit.u.uSrc, 0);
      gl.bindVertexArray(blitVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteTexture(softTex);
      gl.deleteFramebuffer(softFbo);
      gl.deleteFramebuffer(msaaFbo);
      gl.deleteRenderbuffer(msaaRb);
      gl.deleteVertexArray(blitVao);
      gl.deleteProgram(blit.program);
    },
  };
  target.resize();
  return target;
}
