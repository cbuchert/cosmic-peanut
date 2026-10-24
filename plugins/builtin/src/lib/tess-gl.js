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
 *
 * Look (lib/tess-look.js; `setLook(look, quality)`): classic runs the programs above, untouched.
 * Cinematic compiles the surface's programs again with `TESS_CINEMATIC` (on first use; the height
 * pass is shared, it doesn't change), in which the surface lights the print with look.glsl's
 * materials and AO and writes its circle of confusion to alpha. Then the post passes: depth of
 * field (`{ dof: true }` surfaces, while `setFocus` gives an aperture; dof.frag), the highlight
 * bloom (bloom.frag through lib/lattice-bloom.js) and the composite with the tone curve
 * (post.frag) instead of paper.frag. The cinematic uniforms (`u_kFocus`, `u_kSamples`) are set
 * here; a surface sets its own (`u_k*`) in its setSurface, where `look` tells it which programs
 * are drawing.
 */
import { createBloom } from "./lattice-bloom.js";
import { createProgram, createTarget } from "./gl.js";
import { BLOOM_GAIN, lookDefines, lookOf, lookSamples } from "./tess-look.js";

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
export async function createTessPipeline(ctx, surface, { relief = false, dof = false } = {}) {
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
  /** A cinematic main program (the height passes are the classic ones). @param {string[]} defs @param {string} label */
  const cineProgram = (defs, label) => {
    const pr = createProgram(gl, vs, withDefines(src, [...defs, ...lookDefines("cinematic")]), `${surface} (${label})`);
    atlasUnits([pr]);
    return pr;
  };
  const rel = relief ? { ...reliefPair([], "relief"), target: createTarget(gl) } : null;
  /** The carved animals' relief pair, compiled the first time the atlas motif shows in relief. */
  let relAtlas = /** @type {ReturnType<typeof reliefPair> | null} */ (null);
  /**
   * Exact cut sides (tess.glsl tessRefineHit) for a surface that defines TESS_RAY_SOLID: classic
   * draws its relief print with the TESS_EXACT_SIDES variant while cards turn (made here, and the
   * animals' one on first use), its resting frames with the programs above, exactly as before.
   * @param {string[]} defs @param {string} label
   */
  const exactProgram = (defs, label) => {
    const pr = createProgram(gl, vs, withDefines(src, ["TESS_RELIEF", ...defs, "TESS_EXACT_SIDES"]), `${surface} (${label})`);
    atlasUnits([pr]);
    return pr;
  };
  const exactSides = Boolean(rel) && surfFs.includes("TESS_RAY_SOLID");
  const relExact = exactSides ? exactProgram([], "relief, exact sides") : null;
  let relAtlasExact = /** @type {ReturnType<typeof createProgram> | null} */ (null);
  const paper = createProgram(gl, vs, paperFs, DIR + "paper.frag");
  const u = prog.u;
  atlasUnits([prog]);
  const vao = gl.createVertexArray();
  const target = createTarget(gl);
  let scale = 1;

  /**
   * The cinematic Look's programs and targets, made the first time it is used (classic never
   * creates them). @type {null | {
   *   plain: ReturnType<typeof createProgram>, relief: ReturnType<typeof createProgram> | null,
   *   reliefAtlas: ReturnType<typeof createProgram> | null, post: ReturnType<typeof createProgram>,
   *   dof: ReturnType<typeof createProgram> | null, dofTarget: ReturnType<typeof createTarget> | null,
   *   bloom: ReturnType<typeof createBloom>, bloomProgs: import('./lattice-bloom.js').BloomPrograms }}
   */
  let cine = null;
  let cinematic = false;
  let samples = lookSamples("high");
  /** setFocus: focus depth, aperture and cap (full-resolution px), the key light on screen. */
  let focusZ = 1;
  let aperture = 0;
  let cocCap = 0;
  let lightX = 0;
  let lightY = 0;

  async function makeCinematic() {
    const [postFs, bloomFs, dofFs] = await Promise.all(["post.frag", "bloom.frag", "dof.frag"].map((f) => ctx.assets.text(DIR + f)));
    const c = {
      plain: cineProgram([], "cinematic"),
      relief: rel ? cineProgram(["TESS_RELIEF"], "relief, cinematic") : null,
      reliefAtlas: /** @type {ReturnType<typeof createProgram> | null} */ (null),
      post: createProgram(gl, vs, postFs, DIR + "post.frag"),
      dof: dof ? createProgram(gl, vs, dofFs, DIR + "dof.frag") : null,
      dofTarget: dof ? createTarget(gl) : null,
      bloom: createBloom(gl),
      bloomProgs: {
        karis: createProgram(gl, vs, withDefines(bloomFs, ["KARIS"]), DIR + "bloom.frag (karis)"),
        down: createProgram(gl, vs, bloomFs, DIR + "bloom.frag"),
        up: createProgram(gl, vs, withDefines(bloomFs, ["UP"]), DIR + "bloom.frag (up)"),
      },
    };
    cine = c;
    resize();
  }

  function resize(/** @type {number} */ s = scale) {
    scale = s;
    target.resize(Math.max(1, Math.round(ctx.size.width * scale)), Math.max(1, Math.round(ctx.size.height * scale)));
    rel?.target.resize(Math.max(1, Math.round(target.width * HEIGHT_SCALE)), Math.max(1, Math.round(target.height * HEIGHT_SCALE)));
    if (cine) {
      cine.dofTarget?.resize(target.width, target.height);
      cine.bloom.resize(target.width, target.height);
    }
  }

  /** The cinematic uniforms of a program. @param {Record<string, WebGLUniformLocation | null>} u */
  function uploadLook(u) {
    gl.uniform4f(u.u_kFocus, focusZ, aperture * scale, cocCap * scale, 0);
    gl.uniform4i(u.u_kSamples, samples.aoDirs, samples.aoSteps, samples.shadow, 0);
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
  /** @type {Promise<void> | null} */
  let pending = null;

  /**
   * The cinematic frame: the height pass (shared with classic), the cinematic print, then depth of
   * field, bloom and the composite. @param {TessState} s @param {SetSurface} setSurface
   * @param {number} motif @param {NonNullable<typeof cine>} c
   */
  function renderCinematic(s, setSurface, motif, c) {
    const { width: w, height: h } = ctx.size;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);
    let main = c.plain;
    if (rel && c.relief && s.relief > 0) {
      const atlasRelief = atlas && motif === 1;
      if (atlasRelief && !relAtlas) relAtlas = reliefPair(["TESS_ATLAS_RELIEF"], "relief, atlas");
      if (atlasRelief && !c.reliefAtlas) c.reliefAtlas = cineProgram(["TESS_RELIEF", "TESS_ATLAS_RELIEF"], "relief, atlas, cinematic");
      const pair = atlasRelief && relAtlas ? relAtlas : rel;
      main = atlasRelief && c.reliefAtlas ? c.reliefAtlas : c.relief;
      const hu = pair.height.u;
      gl.bindFramebuffer(gl.FRAMEBUFFER, rel.target.fbo);
      gl.viewport(0, 0, rel.target.width, rel.target.height);
      gl.useProgram(pair.height.program);
      gl.uniform2f(hu.u_res, rel.target.width, rel.target.height);
      upload(hu, s, w);
      uploadRelief(hu, s);
      setSurface(gl, hu, rel.target.width, rel.target.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const mu = main.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(main.program);
    gl.uniform2f(mu.u_res, target.width, target.height);
    upload(mu, s, w);
    uploadLook(mu);
    if (main !== c.plain && rel) {
      uploadRelief(mu, s);
      gl.activeTexture(gl.TEXTURE0 + HEIGHT_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, rel.target.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(mu.u_tHeight, HEIGHT_UNIT);
      gl.uniform2f(mu.u_tHeightTexel, 1 / rel.target.width, 1 / rel.target.height);
    }
    setSurface(gl, mu, target.width, target.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Depth of field (the surface wrote its circle of confusion to alpha).
    let print = target;
    if (c.dof && c.dofTarget && aperture > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, c.dofTarget.fbo);
      gl.viewport(0, 0, c.dofTarget.width, c.dofTarget.height);
      gl.useProgram(c.dof.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.uniform1i(c.dof.u.u_src, 0);
      gl.uniform2f(c.dof.u.u_texel, 1 / target.width, 1 / target.height);
      gl.uniform1i(c.dof.u.u_taps, samples.dofTaps);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      print = c.dofTarget;
    }
    c.bloom.render(print.tex, print.width, print.height, c.bloomProgs, /** @type {WebGLVertexArrayObject} */ (vao));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(c.post.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, c.bloom.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, print.tex);
    gl.uniform1i(c.post.u.u_print, 0);
    gl.uniform1i(c.post.u.u_bloom, 1);
    gl.uniform1f(c.post.u.u_bloomN, c.bloom.levels);
    gl.uniform1f(c.post.u.u_bloomK, BLOOM_GAIN);
    gl.uniform3fv(c.post.u.u_paper, s.paper);
    gl.uniform1f(c.post.u.u_grain, GRAIN);
    gl.uniform2f(c.post.u.u_lightScr, lightX, lightY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      if (cinematic && cine) {
        renderCinematic(s, setSurface, motif, cine);
        return;
      }
      const { width: w, height: h } = ctx.size;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      if (rel && s.relief > 0) {
        if (atlas && motif === 1 && !relAtlas) relAtlas = reliefPair(["TESS_ATLAS_RELIEF"], "relief, atlas");
        const pair = atlas && motif === 1 && relAtlas ? relAtlas : rel;
        let main = pair.main;
        if (relExact && s.flipping) {
          if (pair === rel) main = relExact;
          else main = relAtlasExact ??= exactProgram(["TESS_ATLAS_RELIEF"], "relief, atlas, exact sides");
        }
        const hu = pair.height.u;
        gl.bindFramebuffer(gl.FRAMEBUFFER, rel.target.fbo);
        gl.viewport(0, 0, rel.target.width, rel.target.height);
        gl.useProgram(pair.height.program);
        gl.uniform2f(hu.u_res, rel.target.width, rel.target.height);
        upload(hu, s, w);
        uploadRelief(hu, s);
        setSurface(gl, hu, rel.target.width, rel.target.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        const ru = main.u;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
        gl.useProgram(main.program);
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
    /** True while the cinematic programs draw (a surface's setSurface may set its u_k* then). */
    get look() {
      return cinematic && cine ? "cinematic" : "classic";
    },
    /**
     * Switch the Look (lib/tess-look.js lookOf) and the Quality's sample counts. The cinematic
     * programs compile on the first switch (asynchronously: classic keeps drawing until they're
     * ready). @param {unknown} look @param {unknown} quality
     */
    setLook(look, quality) {
      cinematic = lookOf(look) === "cinematic";
      samples = lookSamples(quality);
      if (cinematic && !cine && !pending) {
        pending = makeCinematic().catch((e) => {
          // Classic keeps drawing; the error still surfaces (create awaits it, a param change rejects).
          cinematic = false;
          pending = null;
          throw e;
        });
      }
      return pending ?? Promise.resolve();
    },
    /**
     * Depth of field for this frame (a `{ dof: true }` surface): the focus depth (the surface's
     * own depth units), the blur far away and its cap, full-resolution px (0: none), and the key
     * light's direction on screen for the paper's fibres (any surface; unit or 0).
     * @param {number} z @param {number} blur @param {number} cap @param {number} lx @param {number} ly
     */
    setFocus(z, blur, cap, lx = 0, ly = 0) {
      focusZ = z;
      aperture = dof ? blur : 0;
      cocCap = cap;
      lightX = lx;
      lightY = ly;
    },
    dispose() {
      if (cine) {
        for (const p of [cine.plain, cine.relief, cine.reliefAtlas, cine.post, cine.dof, cine.bloomProgs.karis, cine.bloomProgs.down, cine.bloomProgs.up]) {
          if (p) gl.deleteProgram(p.program);
        }
        cine.dofTarget?.dispose();
        cine.bloom.dispose();
      }
      for (const p of [relExact, relAtlasExact]) if (p) gl.deleteProgram(p.program);
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
