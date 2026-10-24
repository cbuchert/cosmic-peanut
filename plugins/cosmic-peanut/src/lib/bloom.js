// @ts-check
/**
 * Physically based bloom for the cinematic look, after Jorge Jimenez, "Next Generation Post
 * Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014 (Advances in Real-Time
 * Rendering). The scene is downsampled into a chain of mips, each half the last, with his
 * 13-tap filter (shaders/bloom-down.frag: five overlapping 2×2 boxes, weights 0.5 for the
 * centre box and 0.125 for each corner box, so it sums to 1 and preserves the mean). The first
 * downsample weights each box by 1 ÷ (1 + luma), Karis's average (Brian Karis, "Real Shading in
 * Unreal Engine 4", SIGGRAPH 2013 course notes, and Jimenez's slides), so lone hot pixels can't
 * flicker into big blobs. Then each mip is upsampled with a 3×3 tent (shaders/bloom-up.frag) and
 * added onto the next larger one, from the smallest up, so mip 0 ends up holding the sum of every
 * level, each blurred more than the last. Every level keeps the scene's mean, so mip 0 ÷ levels
 * does too, and the composite lerps toward it (shaders/composite.frag): energy-conserving, light
 * is spread, never added. `run` allocates nothing; `resize` (re)allocates only on a new size.
 */

/** Mips at most (6 at 1440p, from 1280 × 720 down to 40 × 22, as in Jimenez's slides). */
export const MAX_LEVELS = 6;
/** No mip side drops below this, in texels (beyond the first). */
const MIN_SIDE = 4;

/**
 * The chain's sizes: half the scene's size, halving again while there's room.
 * @param {number} w @param {number} h scene size, pixels @returns {[number, number][]}
 */
export function bloomChain(w, h) {
  /** @type {[number, number][]} */
  const out = [[Math.max(1, w >> 1), Math.max(1, h >> 1)]];
  while (out.length < MAX_LEVELS) {
    const [pw, ph] = out[out.length - 1];
    const nw = pw >> 1;
    const nh = ph >> 1;
    if (Math.min(nw, nh) < MIN_SIDE) break;
    out.push([nw, nh]);
  }
  return out;
}

/**
 * @typedef {{ program: WebGLProgram, u: Record<string, WebGLUniformLocation | null> }} Program
 * @typedef {{ internal: number, format: number, type: number }} Format a colour-renderable texture format
 */

/**
 * The mip chain's textures and framebuffers, and the passes that fill it.
 * @param {WebGL2RenderingContext} gl
 * @param {Program} down shaders/bloom-down.frag @param {Program} up shaders/bloom-up.frag
 * @param {Format} fmt
 */
export function createBloom(gl, down, up, fmt) {
  const tex = /** @type {WebGLTexture[]} */ ([]);
  const fbo = /** @type {WebGLFramebuffer[]} */ ([]);
  for (let i = 0; i < MAX_LEVELS; i++) {
    tex.push(/** @type {WebGLTexture} */ (gl.createTexture()));
    fbo.push(/** @type {WebGLFramebuffer} */ (gl.createFramebuffer()));
  }
  const sizeW = new Int32Array(MAX_LEVELS);
  const sizeH = new Int32Array(MAX_LEVELS);
  let sceneW = 0;
  let sceneH = 0;

  /** Draw one fullscreen pass from `src` (texel size 1/sw, 1/sh) into mip i. */
  function pass(/** @type {Program} */ p, /** @type {number} */ i, /** @type {WebGLTexture} */ src, /** @type {number} */ sw, /** @type {number} */ sh, /** @type {WebGLVertexArrayObject} */ vao) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
    gl.viewport(0, 0, sizeW[i], sizeH[i]);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(p.u.uSrc ?? null, 0);
    gl.uniform2f(p.u.uTexel ?? null, 1 / sw, 1 / sh);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const bloom = {
    /** Mips in use. */
    levels: 0,
    /** Mip 0: after `run`, the sum of every level (divide by `levels` for the mean-preserving bloom). */
    texture: tex[0],
    /** Size the chain for a scene of w × h. Allocates; only when the size changes. @param {number} w @param {number} h */
    resize(w, h) {
      if (w === sceneW && h === sceneH) return;
      sceneW = w;
      sceneH = h;
      const chain = bloomChain(w, h);
      bloom.levels = chain.length;
      for (let i = 0; i < chain.length; i++) {
        sizeW[i] = chain[i][0];
        sizeH[i] = chain[i][1];
        gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, sizeW[i], sizeH[i], 0, fmt.format, fmt.type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    /**
     * Downsample the scene through the chain (Karis average on the first step), then tent-upsample
     * and add back up to mip 0. Leaves blending off.
     * @param {WebGLTexture} scene @param {WebGLVertexArrayObject} vao a VAO for fullscreen triangles
     */
    run(scene, vao) {
      const L = bloom.levels;
      gl.disable(gl.BLEND);
      for (let i = 0; i < L; i++) {
        if (i === 0) {
          gl.useProgram(down.program);
          gl.uniform1f(down.u.uKaris ?? null, 1);
          pass(down, 0, scene, sceneW, sceneH, vao);
          gl.uniform1f(down.u.uKaris ?? null, 0);
        } else {
          pass(down, i, tex[i - 1], sizeW[i - 1], sizeH[i - 1], vao);
        }
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = L - 2; i >= 0; i--) pass(up, i, tex[i + 1], sizeW[i + 1], sizeH[i + 1], vao);
      gl.disable(gl.BLEND);
    },
    dispose() {
      for (let i = 0; i < MAX_LEVELS; i++) {
        gl.deleteTexture(tex[i]);
        gl.deleteFramebuffer(fbo[i]);
      }
    },
  };
  return bloom;
}
