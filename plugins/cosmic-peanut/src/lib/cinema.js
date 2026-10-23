// @ts-check
/**
 * The cinematic look's render target and post chain (GL glue shared by both entry modules):
 *
 * 1. The lines (prefiltered quads, ./quads.js and shaders/quad.glsl) add up as linear light in a
 *    full-resolution RGBA16F scene, so overlaps never clip. Rendering to RGBA16F needs
 *    EXT_color_buffer_float (or EXT_color_buffer_half_float); WebKit has both. Without them the
 *    scene is RGBA8 with the lines stored at RGBA8_SCALE for headroom, and the composite scales
 *    back up: it clips later and bands a little in the darks, but still works.
 * 2. Bloom: Jimenez's 13-tap downsample chain and tent upsample (./bloom.js).
 * 3. The composite (shaders/composite.frag) onto the canvas: aberration, an energy-conserving
 *    bloom lerp, exposure, the ACES fit, encode, vignette, grain, and alpha = max(rgb), so it is
 *    still premultiplied light over a transparent canvas (./look.js).
 *
 * `begin` and `end` allocate nothing; `resize` reallocates only on a new canvas size.
 */
import { createBloom } from "./bloom.js";
import { createProgram } from "./gl.js";
import { CINEMA, grainSeed } from "./look.js";

/** RGBA8 fallback: the lines are stored at this fraction, leaving 4× headroom before clipping. */
export const RGBA8_SCALE = 0.25;

/** Shader assets the cinematic look needs beyond its line shaders. */
export const CINEMA_ASSETS = Object.freeze({
  quad: "shaders/quad.glsl",
  down: "shaders/bloom-down.frag",
  up: "shaders/bloom-up.frag",
  composite: "shaders/composite.frag",
});

const MARKER = "//#include quad";

/**
 * Splice shaders/quad.glsl into a quad-*.vert at its marker (GLSL ES has no #include).
 * @param {string} src @param {string} lib
 */
export function includeQuad(src, lib) {
  if (!src.includes(MARKER)) throw new Error(`cosmic-peanut: shader has no "${MARKER}"`);
  return src.replace(MARKER, lib);
}

/**
 * The scene's format: RGBA16F when the context can render to it (checked with a tiny
 * framebuffer), RGBA8 otherwise. `scale` is what the lines are multiplied by going in.
 * @param {WebGL2RenderingContext} gl
 */
export function hdrFormat(gl) {
  if (gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float")) {
    const t = gl.createTexture();
    const f = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f);
    gl.deleteTexture(t);
    if (ok) return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, scale: 1, float: true };
  }
  return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, scale: RGBA8_SCALE, float: false };
}

/**
 * @typedef {{ blitVs: string, down: string, up: string, composite: string }} CinemaSources
 */

/**
 * @param {WebGL2RenderingContext} gl
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @param {CinemaSources} src
 * @param {{ css?: boolean }} [opts] css: render the scene at CSS-pixel size and let the composite
 *   upscale it (like the classic soft lines): a quarter of the fill at DPR 2
 */
export function createCinema(gl, ctx, src, opts = {}) {
  const fmt = hdrFormat(gl);
  const down = createProgram(gl, src.blitVs, src.down, "shaders/bloom-down");
  const up = createProgram(gl, src.blitVs, src.up, "shaders/bloom-up");
  const comp = createProgram(gl, src.blitVs, src.composite, "shaders/composite");
  const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const sceneTex = /** @type {WebGLTexture} */ (gl.createTexture());
  const sceneFbo = gl.createFramebuffer();
  const bloom = createBloom(gl, down, up, fmt);
  let mip0W = 1;
  let mip0H = 1;

  const cine = {
    /** What the lines are multiplied by going into the scene (1, or RGBA8_SCALE). */
    scale: fmt.scale,
    /** Whether the scene is a float target. */
    float: fmt.float,
    /** Scene size, pixels (the canvas's drawing buffer, or its CSS size). */
    width: 0,
    height: 0,
    /** Scene pixels per CSS pixel. */
    density: 1,
    /** Size the scene and the bloom chain to the canvas. Allocates; only on a new size. */
    resize() {
      const css = opts.css === true;
      const w = Math.max(1, css ? Math.min(ctx.size.width, Math.round(ctx.size.cssWidth)) : ctx.size.width);
      const h = Math.max(1, css ? Math.min(ctx.size.height, Math.round(ctx.size.cssHeight)) : ctx.size.height);
      cine.density = w / Math.max(1, ctx.size.cssWidth);
      if (w === cine.width && h === cine.height) return;
      cine.width = w;
      cine.height = h;
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      bloom.resize(w, h);
      mip0W = Math.max(1, w >> 1);
      mip0H = Math.max(1, h >> 1);
    },
    /**
     * The line program's look uniforms: target size, core half width and prefilter (Lines fine is
     * one scene pixel wide), the RGBA8 fallback's headroom scale, and depth of field.
     * @param {Record<string, WebGLUniformLocation | null>} U @param {boolean} fine
     * @param {number} width line core width for Lines soft, CSS px
     * @param {number} focus focal distance @param {number} aperture blur far away, CSS px (0: none)
     * @param {number} cocMax blur cap, CSS px
     */
    lineUniforms(U, fine, width, focus, aperture, cocMax) {
      gl.uniform2f(U.uViewport ?? null, cine.width, cine.height);
      gl.uniform1f(U.uHalf ?? null, fine ? 0.5 : 0.5 * width * cine.density);
      gl.uniform1f(U.uSigma ?? null, CINEMA.sigma);
      gl.uniform1f(U.uScale ?? null, cine.scale);
      gl.uniform1f(U.uFocus ?? null, focus);
      gl.uniform1f(U.uAperture ?? null, aperture * cine.density);
      gl.uniform1f(U.uCocMax ?? null, cocMax * cine.density);
    },
    /** Bind the scene and clear it. */
    begin() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.viewport(0, 0, cine.width, cine.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    /**
     * Bloom the scene and composite it onto the canvas. Leaves texture unit 0 active.
     * @param {number} now seconds (grain) @param {boolean} still hold the grain (Reduce flashing / motion)
     * @param {number} bloomMix the bloom's share of the light
     */
    end(now, still, bloomMix) {
      bloom.run(sceneTex, vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      gl.useProgram(comp.program);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloom.texture);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      const U = comp.u;
      gl.uniform1i(U.uScene ?? null, 0);
      gl.uniform1i(U.uBloom ?? null, 1);
      gl.uniform2f(U.uBloomTexel ?? null, 1 / mip0W, 1 / mip0H);
      const ab = CINEMA.aberration * cine.density;
      gl.uniform2f(U.uAberration ?? null, ab / cine.width, ab / cine.height);
      gl.uniform1f(U.uBloomNorm ?? null, 1 / bloom.levels);
      gl.uniform1f(U.uBloomMix ?? null, bloomMix);
      gl.uniform1f(U.uExposure ?? null, CINEMA.exposure);
      gl.uniform1f(U.uVignette ?? null, CINEMA.vignette);
      gl.uniform1f(U.uGrain ?? null, CINEMA.grain);
      gl.uniform1f(U.uSeed ?? null, grainSeed(now, still));
      gl.uniform1f(U.uInvScale ?? null, 1 / cine.scale);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      bloom.dispose();
      gl.deleteTexture(sceneTex);
      gl.deleteFramebuffer(sceneFbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(down.program);
      gl.deleteProgram(up.program);
      gl.deleteProgram(comp.program);
    },
  };
  cine.resize();
  return cine;
}
