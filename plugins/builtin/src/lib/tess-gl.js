// @ts-check
/**
 * WebGL2 side of the tessellation seam. A surface visualizer supplies one fragment shader that
 * maps its pixel to the tiling plane and calls `tessShade` (see shaders/tess/tess.glsl); this
 * compiles it with the engine spliced in, renders it into a print target at the render scale,
 * uploads every u_t* uniform from a lib/tess-music.js createTessState() state, and presses the
 * result into paper at full resolution (shaders/tess/paper.frag).
 *
 *   const tess = await createTessPipeline(ctx, "shaders/tess/metamorphosis.frag");
 *   tess.resize(renderScale(ctx.params.quality));
 *   // frame():
 *   const s = state.step(audio, time.dt, options);
 *   tess.render(s, (gl, u, w, h) => { gl.uniform2f(u.u_O, x, y); gl.uniform3f(u.u_tRing, …); });
 *
 * The pipeline sets `u_res` (the print target's size) itself. Nothing is allocated per frame.
 */
import { createProgram, createTarget } from "./gl.js";

const DIR = "shaders/tess/";
/** Paper texture strength in the composite. */
const GRAIN = 1;

/**
 * @typedef {ReturnType<typeof import('./tess-music.js').createTessState>} TessState
 * @typedef {(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, width: number, height: number) => void} SetSurface
 */

const INCLUDE = /^\/\/ #include ([\w-]+)$/gm;

/**
 * The names of a shader's include lines (`// #include <name>` alone on a line), in order, once
 * each. `tess` is the engine; any other name is shaders/tess/<name>.glsl.
 * @param {string} src @returns {string[]}
 */
export const includesOf = (src) => [...new Set(Array.from(src.matchAll(INCLUDE), (m) => m[1]))];

/** Replace each include line with its file's text. @param {string} src @param {Record<string, string>} files */
export const spliceIncludes = (src, files) => src.replace(INCLUDE, (line, name) => files[name] ?? line);

/**
 * @param {import('../../tidalviz').VisualizerContext} ctx
 * @param {string} surface path of the surface fragment shader (it contains `// #include tess`, and
 *   may include other shaders/tess/<name>.glsl files the same way)
 */
export async function createTessPipeline(ctx, surface) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const [vs, engine, paperFs, surfFs] = await Promise.all(
    [DIR + "fullscreen.vert", DIR + "tess.glsl", DIR + "paper.frag", surface].map((f) => ctx.assets.text(f)),
  );
  /** @type {Record<string, string>} */
  const files = { tess: engine };
  const extra = includesOf(surfFs).filter((n) => n !== "tess");
  const texts = await Promise.all(extra.map((n) => ctx.assets.text(DIR + n + ".glsl")));
  extra.forEach((n, i) => (files[n] = texts[i]));
  const prog = createProgram(gl, vs, spliceIncludes(surfFs, files), surface);
  const paper = createProgram(gl, vs, paperFs, DIR + "paper.frag");
  const u = prog.u;
  const vao = gl.createVertexArray();
  const target = createTarget(gl);
  let scale = 1;

  function resize(/** @type {number} */ s = scale) {
    scale = s;
    target.resize(Math.max(1, Math.round(ctx.size.width * scale)), Math.max(1, Math.round(ctx.size.height * scale)));
  }
  resize();

  return {
    /** The surface program and its uniform locations (for surface-specific uniforms). */
    program: prog.program,
    u,
    /** (Re)size the print target: render scale × canvas (call on ctx resize too). */
    resize,
    /** @param {TessState} s @param {SetSurface} setSurface */
    render(s, setSurface) {
      const { width: w, height: h } = ctx.size;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
      gl.useProgram(prog.program);
      gl.uniform2f(u.u_res, target.width, target.height);
      gl.uniform1i(u.u_tGroup, s.group.name === "p3" ? 1 : 0);
      gl.uniform1i(u.u_tN, s.nTerms);
      gl.uniform4fv(u.u_tK, s.k);
      gl.uniform4fv(u.u_tAB, s.ab);
      gl.uniform3fv(u.u_tBlend, s.blend);
      gl.uniform3fv(u.u_tPaper, s.paper);
      gl.uniform3fv(u.u_tInk, s.ink);
      gl.uniform3fv(u.u_tCls, s.cls);
      gl.uniform3fv(u.u_tClsNext, s.clsNext);
      gl.uniform3fv(u.u_tAvg, s.avg);
      gl.uniform3fv(u.u_tInvert, s.invert);
      gl.uniform1f(u.u_tInkW, s.inkW);
      gl.uniform1f(u.u_tHatch, s.hatch);
      gl.uniform2fv(u.u_tReg, s.reg);
      gl.uniform1fv(u.u_tBands, s.bands);
      gl.uniform4fv(u.u_tFeatA, s.featA);
      gl.uniform4fv(u.u_tFeatB, s.featB);
      gl.uniform1f(u.u_tPxScale, target.width / Math.max(1, w));
      setSurface(gl, u, target.width, target.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(paper.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.uniform1i(paper.u.u_print, 0);
      gl.uniform3fv(paper.u.u_paper, s.paper);
      gl.uniform1f(paper.u.u_grain, GRAIN);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      target.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(paper.program);
    },
  };
}
