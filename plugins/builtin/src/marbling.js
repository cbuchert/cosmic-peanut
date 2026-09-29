// @ts-check
/**
 * Marbling — live marbled paper (ebru / oil marbling) poured by the music, for `webgl2`.
 *
 * A GPU feedback simulation of the mathematical-marbling maps (Jaffer et al.): a ping-pong RGBA8
 * texture holds the amount of each of four inks per pixel (paper = the rest). Each frame the pour
 * scheduler (lib/marbling.js) turns the audio into at most 16 events — slices of drops being
 * poured, a stylus step, a whole-pixel drift — appended to a queue of up to 48 pending events.
 * composite.frag shows the texture pushed through all pending events (walking each pixel back
 * through their exact inverse maps, events.glsl) and colours the inks with the palette over cream
 * (or clear) paper; only when the queue is full does sim.frag bake them into the other texture,
 * resampling it sharply (sample.glsl). Baking ~10× less often than every frame is what keeps the
 * veins crisp. The cost per frame is bounded however much has been poured.
 *
 * Beats drop paint (the spectral region that hit picks the size and ink; kicks bring satellite
 * drops → nested cells), a stylus following the spectral centroid rakes clear paper rivers
 * through it, loudness sets the pour rate, and slow drift plus occasional large clear drops renew
 * the page.
 */
import { createProgram } from "./lib/gl.js";
import {
  createEventQueue,
  createMarbler,
  DEFAULTS,
  effectiveParams,
  paletteOf,
  resizeMap,
} from "./lib/marbling.js";

/** Anti-diffusion strength of the sharp resampler (sample.glsl), tuned by measured edge width. */
const SHARP = 0.1;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/marbling/";
  const [vs, sampleSrc, eventsSrc, simFs, resampleFs, compFs] = await Promise.all(
    ["fullscreen.vert", "sample.glsl", "events.glsl", "sim.frag", "resample.frag", "composite.frag"].map(
      (f) => ctx.assets.text(dir + f),
    ),
  );
  const include = (/** @type {string} */ src) =>
    src.replace("#include sample.glsl", sampleSrc).replace("#include events.glsl", eventsSrc);
  const sim = createProgram(gl, vs, include(simFs), dir + "sim.frag");
  const resample = createProgram(gl, vs, include(resampleFs), dir + "resample.frag");
  const comp = createProgram(gl, vs, include(compFs), dir + "composite.frag");
  const vao = gl.createVertexArray();

  /** An RGBA8 ink texture + framebuffer, cleared to clear paper. */
  function createInk(/** @type {number} */ w, /** @type {number} */ h) {
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }
  /** @param {{ tex: WebGLTexture, fbo: WebGLFramebuffer }} t */
  function freeInk(t) {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  /** @type {ReturnType<typeof createInk>[]} */
  let inks = [];
  let cur = 0;
  const marbler = createMarbler(0x6d61726c);
  const queue = createEventQueue();
  const eff = { ...DEFAULTS };
  const env = { aspect: 1, pxPerUnit: 1, reduceFlashing: true, reduceMotion: false };
  const inkColors = new Float32Array(12);
  const paper = new Float32Array(4);
  const map = new Float64Array(5);

  function applyParams() {
    const pal = paletteOf(ctx.params.palette);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) inkColors[i * 3 + k] = pal.inks[i][k];
    const on = ctx.params.paper !== "none" ? 1 : 0;
    for (let k = 0; k < 3; k++) paper[k] = pal.paper[k] * on;
    paper[3] = on;
  }

  /** Bind `src` as the texture sample.glsl reads. @param {WebGLTexture} tex @param {{ program: WebGLProgram, u: Record<string, WebGLUniformLocation | null> }} p @param {number} w @param {number} h @param {number} sharp */
  function bindPrev(p, tex, w, h, sharp) {
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.u_prev, 0);
    gl.uniform2f(p.u.u_prevSize, w, h);
    gl.uniform1f(p.u.u_sharp, sharp);
  }

  /** Upload the pending events to a program that includes events.glsl. @param {{ u: Record<string, WebGLUniformLocation | null> }} p */
  function setEvents(p) {
    gl.uniform1i(p.u.u_n, queue.count);
    gl.uniform4fv(p.u.u_a, queue.evA);
    gl.uniform4fv(p.u.u_b, queue.evB);
    gl.uniform4fv(p.u.u_c, queue.evC);
    gl.uniform4fv(p.u.u_d, queue.evD);
  }

  /** Bake the pending events into the other ink texture and empty the queue. */
  function bake() {
    if (queue.count === 0) return;
    const src = inks[cur];
    const dst = inks[cur ^ 1];
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    bindPrev(sim, src.tex, src.w, src.h, sharpness());
    setEvents(sim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cur ^= 1;
    queue.clear();
  }

  function sharpness() {
    return ctx.params._sharp !== undefined ? Number(ctx.params._sharp) : SHARP;
  }

  function resize() {
    const w = Math.max(1, ctx.size.width);
    const h = Math.max(1, ctx.size.height);
    if (inks[cur] && inks[cur].w === w && inks[cur].h === h) return;
    if (inks[cur]) bake();
    const old = inks[cur];
    const next = [createInk(w, h), createInk(w, h)];
    if (old) {
      // Carry the paint over: centred, cropped or scaled up, never stretched or reset.
      resizeMap(old.w / old.h, w / h, map);
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, next[0].fbo);
      gl.viewport(0, 0, w, h);
      bindPrev(resample, old.tex, old.w, old.h, 0);
      gl.uniform2f(resample.u.u_size, w, h);
      gl.uniform4f(resample.u.u_map, map[0], map[1], map[2], 0);
      gl.uniform2f(resample.u.u_newC, map[3], map[4]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      marbler.remap(map);
      for (const t of inks) freeInk(t);
    }
    inks = next;
    cur = 0;
  }

  applyParams();
  resize();

  return {
    frame(audio, time) {
      const src = inks[cur];
      effectiveParams(ctx.params, ctx.reduceMotion, eff);
      env.aspect = src.w / src.h;
      env.pxPerUnit = src.h;
      env.reduceFlashing = ctx.reduceFlashing;
      env.reduceMotion = ctx.reduceMotion;
      marbler.step(audio, time.dt, eff, env);

      if (!queue.fits(marbler.count)) bake();
      queue.append(marbler);

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      const { width: w, height: h } = ctx.size;
      const ink = inks[cur];
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      bindPrev(comp, ink.tex, ink.w, ink.h, 0);
      gl.uniform2f(comp.u.u_size, w, h);
      gl.uniform3fv(comp.u.u_ink, inkColors);
      gl.uniform4fv(comp.u.u_paper, paper);
      gl.uniform1f(comp.u.u_sheen, marbler.sheen);
      setEvents(comp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    resize,

    params() {
      applyParams();
    },

    dispose() {
      for (const t of inks) freeInk(t);
      inks = [];
      gl.deleteVertexArray(vao);
      for (const p of [sim, resample, comp]) gl.deleteProgram(p.program);
    },
  };
}
