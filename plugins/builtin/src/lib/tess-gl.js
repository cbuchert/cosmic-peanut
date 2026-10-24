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
 *
 * Relief (`{ relief: true }`): the surface is compiled twice more with `#define TESS_RELIEF`, once
 * with `TESS_HEIGHT_PASS` too. While the state's `relief` is above 0 each frame first renders the
 * height pass into a HEIGHT_SCALE target (the surface writes tessRelief's height / u_tRelief.z to
 * red), then the relief program into the print target with that bound as `u_tHeight` (texel size
 * `u_tHeightTexel`); at relief 0 the plain program runs exactly as without relief.
 *
 * Carved animals: a surface that defines TESS_ATLAS passes `render(s, setSurface, 1)` while the
 * atlas motif shows (its setSurface binds the atlas, lib/atlas-gl.js). With relief on, that frame
 * runs a second pair of relief programs, compiled (on first use) with `TESS_ATLAS_RELIEF` too, in
 * which tessRelief / tessShadeRelief carve the bestiary's tiles (shaders/tess/atlas.glsl); the
 * warp's relief programs never carry that path, so they stay exactly as they were.
 */
import { createProgram, createTarget } from "./gl.js";

const DIR = "shaders/tess/";
/** Texture units of the atlas motif's field and art textures (lib/atlas-gl.js binds them). */
export const ATLAS_FIELD_UNIT = 1;
export const ATLAS_ART_UNIT = 2;
/** Texture unit of the relief height texture (`u_tHeight`), clear of the atlas units. */
export const HEIGHT_UNIT = 3;
/** Paper texture strength in the composite. */
const GRAIN = 1;
/** Height pass resolution, relative to the print target (heights are smooth; the march samples it). */
export const HEIGHT_SCALE = 0.35;

/** Insert `#define`s after a shader's `#version` line. @param {string} src @param {string[]} names */
export const withDefines = (src, names) => src.replace(/^(#version[^\n]*\n)/, (v) => v + names.map((n) => `#define ${n}\n`).join(""));

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
export async function createTessPipeline(ctx, surface, { relief = false } = {}) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const [vs, engine, paperFs, surfFs] = await Promise.all(
    [DIR + "fullscreen.vert", DIR + "tess.glsl", DIR + "paper.frag", surface].map((f) => ctx.assets.text(f)),
  );
  // A surface that defines TESS_ATLAS also gets the bestiary motif (shaders/tess/atlas.glsl),
  // spliced in after the engine.
  const atlas = surfFs.includes("#define TESS_ATLAS") ? await ctx.assets.text(DIR + "atlas.glsl") : "";
  /** @type {Record<string, string>} */
  const files = { tess: engine + atlas };
  const extra = includesOf(surfFs).filter((n) => n !== "tess");
  const texts = await Promise.all(extra.map((n) => ctx.assets.text(DIR + n + ".glsl")));
  extra.forEach((n, i) => (files[n] = texts[i]));
  const src = spliceIncludes(surfFs, files);
  const prog = createProgram(gl, vs, src, surface);
  /** The atlas samplers live on units 1 and 2 (lib/atlas-gl.js binds them there); left on unit 0
   * they would alias the print target's texture and WebGL refuses the draw. The relief programs
   * carry them too, and keep the height texture off them (HEIGHT_UNIT). @param {{ program: WebGLProgram, u: Record<string, WebGLUniformLocation | null> }[]} prs */
  const atlasUnits = (prs) => {
    if (!atlas) return;
    for (const pr of prs) {
      gl.useProgram(pr.program);
      gl.uniform1i(pr.u.u_aField, ATLAS_FIELD_UNIT);
      gl.uniform1i(pr.u.u_aArt, ATLAS_ART_UNIT);
    }
  };
  /** The relief pair (print and height pass) for a set of extra defines. @param {string[]} defs @param {string} label */
  const reliefPair = (defs, label) => {
    const pair = {
      main: createProgram(gl, vs, withDefines(src, ["TESS_RELIEF", ...defs]), `${surface} (${label})`),
      height: createProgram(gl, vs, withDefines(src, ["TESS_RELIEF", ...defs, "TESS_HEIGHT_PASS"]), `${surface} (${label} height)`),
    };
    atlasUnits([pair.main, pair.height]);
    return pair;
  };
  const rel = relief ? { ...reliefPair([], "relief"), target: createTarget(gl) } : null;
  /** The carved animals' relief pair, compiled the first time the atlas motif shows in relief. */
  let relAtlas = /** @type {ReturnType<typeof reliefPair> | null} */ (null);
  const paper = createProgram(gl, vs, paperFs, DIR + "paper.frag");
  const u = prog.u;
  atlasUnits([prog]);
  const vao = gl.createVertexArray();
  const target = createTarget(gl);
  let scale = 1;

  function resize(/** @type {number} */ s = scale) {
    scale = s;
    target.resize(Math.max(1, Math.round(ctx.size.width * scale)), Math.max(1, Math.round(ctx.size.height * scale)));
    rel?.target.resize(Math.max(1, Math.round(target.width * HEIGHT_SCALE)), Math.max(1, Math.round(target.height * HEIGHT_SCALE)));
  }

  /**
   * Every engine uniform of a program, from the state.
   * @param {Record<string, WebGLUniformLocation | null>} u @param {TessState} s @param {number} w canvas width
   */
  function upload(u, s, w) {
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
  }

  /** The relief uniforms. @param {Record<string, WebGLUniformLocation | null>} u @param {TessState} s */
  function uploadRelief(u, s) {
    gl.uniform4f(u.u_tRelief, s.relief, s.profile, s.reliefMax, s.flipHop);
    gl.uniform1fv(u.u_tLift, s.lift);
    gl.uniform4fv(u.u_tPop, s.pops);
  }
  resize();

  return {
    /** The surface program and its uniform locations (for surface-specific uniforms). */
    program: prog.program,
    u,
    /** (Re)size the print target: render scale × canvas (call on ctx resize too). */
    resize,
    /**
     * @param {TessState} s @param {SetSurface} setSurface
     * @param {number} [motif] 1 while a TESS_ATLAS surface shows the atlas motif (its animals are
     *   carved in relief), else 0
     */
    render(s, setSurface, motif = 0) {
      const { width: w, height: h } = ctx.size;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      if (rel && s.relief > 0) {
        if (atlas && motif === 1 && !relAtlas) relAtlas = reliefPair(["TESS_ATLAS_RELIEF"], "relief, atlas");
        const pair = atlas && motif === 1 && relAtlas ? relAtlas : rel;
        const hu = pair.height.u;
        gl.bindFramebuffer(gl.FRAMEBUFFER, rel.target.fbo);
        gl.viewport(0, 0, rel.target.width, rel.target.height);
        gl.useProgram(pair.height.program);
        gl.uniform2f(hu.u_res, rel.target.width, rel.target.height);
        upload(hu, s, w);
        uploadRelief(hu, s);
        setSurface(gl, hu, rel.target.width, rel.target.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        const ru = pair.main.u;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.useProgram(pair.main.program);
        gl.uniform2f(ru.u_res, target.width, target.height);
        upload(ru, s, w);
        uploadRelief(ru, s);
        gl.activeTexture(gl.TEXTURE0 + HEIGHT_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, rel.target.tex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(ru.u_tHeight, HEIGHT_UNIT);
        gl.uniform2f(ru.u_tHeightTexel, 1 / rel.target.width, 1 / rel.target.height);
        setSurface(gl, ru, target.width, target.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.useProgram(prog.program);
        gl.uniform2f(u.u_res, target.width, target.height);
        upload(u, s, w);
        setSurface(gl, u, target.width, target.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

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
      for (const pair of [rel, relAtlas]) {
        if (!pair) continue;
        gl.deleteProgram(pair.main.program);
        gl.deleteProgram(pair.height.program);
      }
      rel?.target.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(paper.program);
    },
  };
}
