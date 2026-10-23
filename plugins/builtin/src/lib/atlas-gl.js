// @ts-check
/**
 * WebGL2 side of the atlas motif: the bestiary's art library as a data texture, the bake pass
 * (shaders/tess/atlas-bake.frag) into a periodic cell texture, and the uniforms the print pass
 * (shaders/tess/atlas.glsl) reads. A surface that defines TESS_ATLAS uses it like this:
 *
 *   const atlas = await createAtlas(ctx);
 *   atlas.setLibrary(species);                    // once per load (allocates)
 *   // frame(): only when the tile changes (creatures.changed):
 *   atlas.bake(shape, a, b, erodeA, erodeB, dome, moving);
 *   tess.render(s, (gl, u) => { …; atlas.bind(gl, u, s, dip); });
 *
 * The bake is GPU-side and runs only when the tile changes: at ATLAS_MORPH_SIZE² while a morph
 * re-bakes every frame, at ATLAS_SIZE² (mipmapped) once it settles. Nothing is allocated per frame.
 */
import { ATLAS_MORPH_SIZE, ATLAS_SIZE, createAtlasUniforms, DATA_W, packLibrary, packShape } from "./atlas.js";
import { createProgram } from "./gl.js";
import { classColor, MAX_TILE_COLORS, paletteOf } from "./tess.js";
import { ATLAS_ART_UNIT, ATLAS_FIELD_UNIT } from "./tess-gl.js";

const DIR = "shaders/tess/";

/** @param {WebGL2RenderingContext} gl @param {number} size */
function createCellTarget(gl, size) {
  const levels = Math.floor(Math.log2(size)) + 1;
  const make = () => {
    const t = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  };
  const field = make();
  const art = make();
  const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, field, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, art, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { size, field, art, fbo };
}

/** @param {import('../../tidalviz').VisualizerContext} ctx */
export async function createAtlas(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("atlas: needs EXT_color_buffer_float");
  const [vs, fs] = await Promise.all([DIR + "fullscreen.vert", DIR + "atlas-bake.frag"].map((f) => ctx.assets.text(f)));
  const bake = createProgram(gl, vs, fs, DIR + "atlas-bake.frag");
  const bu = bake.u;
  const vao = gl.createVertexArray();
  const big = createCellTarget(gl, ATLAS_SIZE);
  const small = createCellTarget(gl, ATLAS_MORPH_SIZE);
  let current = big;
  const data = /** @type {WebGLTexture} */ (gl.createTexture());
  gl.bindTexture(gl.TEXTURE_2D, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  /** @type {ReturnType<typeof packLibrary>} */
  let lib = { data: new Float32Array(0), rows: 0, sets: new Map() };
  const u = createAtlasUniforms();
  const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
  let palName = "";
  let nColors = 3;
  const accent = new Float32Array(6);
  const none = { start: 0, count: 0 };

  return {
    uniforms: u,
    /** Upload every species' art (the plain tiles' sets are empty). @param {import('./bestiary.js').Species[]} species */
    setLibrary(species) {
      lib = packLibrary(species);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_W, lib.rows, 0, gl.RGBA, gl.FLOAT, lib.data);
    },
    /**
     * Bake the tile into the cell texture. `a`, `b`: the species whose art is drawn (A eroded by
     * erodeA under B eroded by erodeB). @param {import('./bestiary.js').Shape} shape
     * @param {string} a @param {string} b @param {number} erodeA @param {number} erodeB
     * @param {number} dome @param {boolean} moving bake small (a morph re-bakes every frame)
     */
    bake(shape, a, b, erodeA, erodeB, dome, moving) {
      packShape(shape, u);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.max(1, u.n), 1, gl.RGBA, gl.FLOAT, u.outline);
      current = moving ? small : big;
      const sa = lib.sets.get(a) ?? none;
      const sb = a === b ? none : (lib.sets.get(b) ?? none);
      gl.bindFramebuffer(gl.FRAMEBUFFER, current.fbo);
      gl.viewport(0, 0, current.size, current.size);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(bake.program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data);
      gl.uniform1i(bu.u_bData, 0);
      gl.uniform1i(bu.u_bN, u.n);
      gl.uniformMatrix2fv(bu.u_bL, false, u.L);
      gl.uniform1i(bu.u_bCopies, u.nCopies);
      gl.uniform4fv(bu.u_bInv, u.inv);
      gl.uniform4fv(bu.u_bOff, u.off);
      gl.uniform4iv(bu.u_bRange, u.range);
      gl.uniform4fv(bu.u_bBox, u.box);
      gl.uniform2i(bu.u_bSetA, sa.start, sa.count);
      gl.uniform2i(bu.u_bSetB, sb.start, sb.count);
      gl.uniform2f(bu.u_bErode, erodeA, erodeB);
      gl.uniform1f(bu.u_bScale, u.scale);
      gl.uniform1f(bu.u_bDome, dome);
      gl.uniform2f(bu.u_bRes, current.size, current.size);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, current.field);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, current.art);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    /**
     * The print pass's atlas uniforms (call from the surface's setSurface).
     * @param {WebGL2RenderingContext} gl2 @param {Record<string, WebGLUniformLocation | null>} pu
     * @param {{ shift: number }} s the tess state @param {string} palette @param {number} dip
     */
    bind(gl2, pu, s, palette, dip) {
      if (palette !== palName) {
        palName = palette;
        nColors = paletteOf(palette, pal);
      }
      // Accent: the first palette colour no class is using (cycling with the figure/ground shift).
      const classes = u.cls[2];
      for (let h = 0; h < 2; h++) {
        const slot = 6 + classColor(classes, s.shift + h, nColors) * 3;
        for (let i = 0; i < 3; i++) accent[h * 3 + i] = Math.pow(pal[slot + i], 2.2);
      }
      gl2.uniform1i(pu.u_tMotif, 1);
      gl2.uniform4f(pu.u_tFeatA, 0, 0, 0, 0);
      gl2.uniform4f(pu.u_tFeatB, 0, 0, 0, 0);
      gl2.activeTexture(gl2.TEXTURE0 + ATLAS_FIELD_UNIT);
      gl2.bindTexture(gl2.TEXTURE_2D, current.field);
      gl2.activeTexture(gl2.TEXTURE0 + ATLAS_ART_UNIT);
      gl2.bindTexture(gl2.TEXTURE_2D, current.art);
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.uniform2f(pu.u_aRes, current.size, current.size);
      gl2.uniformMatrix2fv(pu.u_aL, false, u.L);
      gl2.uniformMatrix2fv(pu.u_aLinv, false, u.Linv);
      gl2.uniform1f(pu.u_aInv, 1 / u.scale);
      gl2.uniform4fv(pu.u_aCopyInv, u.inv);
      gl2.uniform4fv(pu.u_aCopyOff, u.off);
      gl2.uniform2fv(pu.u_aCtr, u.ctr);
      gl2.uniform3fv(pu.u_aCls, u.cls);
      gl2.uniform3fv(pu.u_aAccent, accent);
      gl2.uniform1f(pu.u_aDip, dip);
    },
    /** Abstract mode: the warp's creatures. @param {WebGL2RenderingContext} gl2 @param {Record<string, WebGLUniformLocation | null>} pu */
    unbind(gl2, pu) {
      gl2.uniform1i(pu.u_tMotif, 0);
    },
    dispose() {
      for (const t of [big, small]) {
        gl.deleteTexture(t.field);
        gl.deleteTexture(t.art);
        gl.deleteFramebuffer(t.fbo);
      }
      gl.deleteTexture(data);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(bake.program);
    },
  };
}
