// @ts-check
/**
 * The cinematic look's bloom chain (Jimenez, "Next Generation Post Processing in Call of Duty:
 * Advanced Warfare", SIGGRAPH 2014 Advances course): the scene pass is downsampled level by level
 * with a 13-tap filter (shaders/lattice/bloom.frag; the first level uses the Karis average, so a
 * single very bright pixel can't flicker into a blob), then upsampled back with a 3 × 3 tent
 * filter, each level added onto the next larger one. Level 0 (half the scene size) ends up holding
 * the sum of all levels; post.frag divides by the level count and mixes it in.
 *
 * Levels are allocated when the size changes (`resize`), never per frame; `render` only binds and
 * draws.
 */

/** Most levels in the chain (from half the scene size). */
export const BLOOM_LEVELS = 6;
/** The smallest level's shorter side (pixels): no level is halved below it. */
export const BLOOM_MIN = 8;

/**
 * The chain's level sizes for a scene of w × h: level 0 is half of it (rounded up), each next
 * level half the last, while its shorter side stays ≥ BLOOM_MIN, up to BLOOM_LEVELS. Always at
 * least one level. Writes (w, h) pairs into `out` and returns the count.
 * @param {number} w @param {number} h @param {Int32Array} out length ≥ 2 × BLOOM_LEVELS
 */
export function bloomSizes(w, h, out) {
  let lw = Math.max(1, Math.ceil(w / 2));
  let lh = Math.max(1, Math.ceil(h / 2));
  out[0] = lw;
  out[1] = lh;
  let n = 1;
  while (n < BLOOM_LEVELS) {
    const nw = Math.ceil(lw / 2);
    const nh = Math.ceil(lh / 2);
    if (Math.min(nw, nh) < BLOOM_MIN) break;
    lw = nw;
    lh = nh;
    out[n * 2] = lw;
    out[n * 2 + 1] = lh;
    n++;
  }
  return n;
}

/**
 * @typedef {{ program: WebGLProgram, u: Record<string, WebGLUniformLocation | null> }} Program
 * @typedef {{ karis: Program, down: Program, up: Program }} BloomPrograms
 */

/** @param {WebGL2RenderingContext} gl */
export function createBloom(gl) {
  const float = Boolean(gl.getExtension("EXT_color_buffer_float"));
  /** @type {WebGLTexture[]} */
  const tex = [];
  /** @type {WebGLFramebuffer[]} */
  const fbo = [];
  const size = new Int32Array(BLOOM_LEVELS * 2);
  const next = new Int32Array(BLOOM_LEVELS * 2);

  /**
   * Bind `p`, its source texture on unit 0 and the source's texel size.
   * @param {Program} p @param {WebGLTexture} src @param {number} sw @param {number} sh
   */
  function use(p, src, sw, sh) {
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(p.u.u_src, 0);
    gl.uniform2f(p.u.u_texel, 1 / sw, 1 / sh);
  }

  const bloom = {
    /** Levels in use (0 before the first resize). */
    levels: 0,
    /** Level 0's texture: the summed bloom, after `render`. @type {WebGLTexture | null} */
    tex: /** @type {WebGLTexture | null} */ (null),
    /**
     * Size the chain for a scene of w × h. Reallocates storage only for levels whose size changed.
     * @param {number} w @param {number} h
     */
    resize(w, h) {
      const n = bloomSizes(w, h, next);
      for (let i = 0; i < n; i++) {
        const lw = next[i * 2];
        const lh = next[i * 2 + 1];
        if (i < bloom.levels && size[i * 2] === lw && size[i * 2 + 1] === lh) continue;
        if (i >= tex.length) {
          tex.push(/** @type {WebGLTexture} */ (gl.createTexture()));
          fbo.push(/** @type {WebGLFramebuffer} */ (gl.createFramebuffer()));
        }
        gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, lw, lh, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
        size[i * 2] = lw;
        size[i * 2 + 1] = lh;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      bloom.levels = n;
      bloom.tex = tex[0];
    },
    /**
     * Run the chain on the scene texture `src` (w × h). Leaves blending off; the caller rebinds
     * its own framebuffer.
     * @param {WebGLTexture} src @param {number} w @param {number} h @param {BloomPrograms} progs
     * @param {WebGLVertexArrayObject} vao
     */
    render(src, w, h, progs, vao) {
      const n = bloom.levels;
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      // Down: 13 taps per pixel; the first level weights its boxes by the Karis average.
      for (let i = 0; i < n; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
        gl.viewport(0, 0, size[i * 2], size[i * 2 + 1]);
        if (i === 0) use(progs.karis, src, w, h);
        else use(progs.down, tex[i - 1], size[i * 2 - 2], size[i * 2 - 1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      // Up: tent-filter each level and add it onto the next larger one.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = n - 1; i >= 1; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i - 1]);
        gl.viewport(0, 0, size[i * 2 - 2], size[i * 2 - 1]);
        use(progs.up, tex[i], size[i * 2], size[i * 2 + 1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    },
    dispose() {
      for (const t of tex) gl.deleteTexture(t);
      for (const f of fbo) gl.deleteFramebuffer(f);
      tex.length = 0;
      fbo.length = 0;
      bloom.levels = 0;
      bloom.tex = null;
    },
  };
  return bloom;
}
