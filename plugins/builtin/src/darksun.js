// @ts-check
/**
 * Dark Sun — after Mogwai's *Every Country's Sun*: a dark sun high in an ash-to-salmon watercolour
 * sky, a glowing horizon across the middle, and hanging from it an upside-down mountain range
 * with a beam of light falling from its heart.
 *
 * The music: the bass swells the sun's rim and the reach of its corona while the "diamond ring"
 * travels slowly round the rim; the inverted range is the live spectrum (log frequency, mirrored,
 * bass at the centre, highs toward its tapered sides, peaks that linger); the beam pulses with the
 * bass and rms; beats flare the beam and the horizon (through the flash limiter) and the horizon
 * breathes with the mids.
 *
 * GPU: the painted sky and ground washes (shaders/darksun/backdrop.frag) render at quarter
 * resolution into their own target — they have no fine detail, and at full resolution they were
 * most of the cost — then one full-screen pass (darksun.frag) draws everything else over them,
 * reading one N × 1 R32F texture of the range profile uploaded per frame. Pure logic lives in lib/horizon.js and lib/darksun.js and is
 * tested there. Nothing is allocated per frame.
 */
import {
  createBeam,
  createDiamond,
  createGlow,
  createSun,
  createSurge,
  isPainted,
  layout,
  PALETTES,
  palette,
  resolveParams,
} from "./lib/darksun.js";
import { createProgram, createTarget } from "./lib/gl.js";
import { createHorizon } from "./lib/horizon.js";

/** Columns across the range (half per side): the ridgeline's resolution. */
const N = 64;
/** Corona rotation (rad/s) at full motion. */
const CORONA_RATE = 0.025;
/** Backdrop target: full-resolution pixels per texel, each way. */
const BG_DIV = 4;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/darksun/";
  const [vs, noise, fs, bgFs] = await Promise.all(
    ["fullscreen.vert", "noise.glsl", "darksun.frag", "backdrop.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const inc = (/** @type {string} */ src) => src.replace("// #include noise", noise);
  const prog = createProgram(gl, vs, inc(fs), dir + "darksun.frag");
  const bgProg = createProgram(gl, vs, inc(bgFs), dir + "backdrop.frag");
  const u = prog.u;
  const ub = bgProg.u;
  const vao = gl.createVertexArray();
  const bgTarget = createTarget(gl);

  const profTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, profTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, N, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const profile = new Float32Array(N);

  const horizon = createHorizon(N);
  const sun = createSun();
  const diamond = createDiamond();
  const beam = createBeam();
  const surge = createSurge();
  const glow = createGlow();
  const pal = palette(ctx.params.palette, new Float32Array(PALETTES.SIZE));
  const P = resolveParams(ctx.params, ctx.reduceMotion, /** @type {any} */ ({}));
  const L = layout(ctx.size.width, ctx.size.height, P, /** @type {any} */ ({}));
  let corona = 0;
  let drift = 0;

  return {
    frame(audio, time) {
      const dt = time.dt;
      const { width: w, height: h } = ctx.size;
      resolveParams(ctx.params, ctx.reduceMotion, P);
      layout(w, h, P, L);
      const r = P.reactivity;

      horizon.step(audio.spectrum, audio.sampleRate, dt, r, profile);
      sun.step(audio.bassAtt, dt, r);
      diamond.step(audio.bassAtt * r, dt, P.motion);
      beam.step(audio.bass, audio.rms, dt, r);
      const flare = surge.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing);
      glow.step(audio.midAtt, flare, dt, r);
      corona += CORONA_RATE * P.motion * (0.6 + 0.8 * sun.level) * dt;
      drift += P.motion * dt;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      const painted = isPainted(ctx.params.backdrop);

      // 1. The painted washes, at quarter resolution.
      if (painted) {
        const tw = Math.max(1, Math.ceil(w / BG_DIV));
        const th = Math.max(1, Math.ceil(h / BG_DIV));
        if (bgTarget.width !== tw || bgTarget.height !== th) bgTarget.resize(tw, th);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bgTarget.fbo);
        gl.viewport(0, 0, tw, th);
        gl.useProgram(bgProg.program);
        gl.uniform2f(ub.u_res, w, h);
        gl.uniform2f(ub.u_scale, w / tw, h / th);
        gl.uniform1f(ub.u_unit, L.unit);
        gl.uniform1f(ub.u_horizon, L.horizon);
        gl.uniform1f(ub.u_time, drift);
        gl.uniform3fv(ub.u_c, pal);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // 2. Everything else, over them.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, profTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RED, gl.FLOAT, profile);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bgTarget.tex);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog.program);
      gl.uniform1i(u.u_prof, 0);
      gl.uniform1i(u.u_bg, 1);
      gl.uniform1f(u.u_n, N);
      gl.uniform2f(u.u_res, w, h);
      gl.uniform1f(u.u_unit, L.unit);
      gl.uniform1f(u.u_horizon, L.horizon);
      gl.uniform3f(u.u_sun, L.sunX, L.sunY, L.sunR);
      gl.uniform1f(u.u_rangeHalf, L.rangeHalf);
      gl.uniform1f(u.u_rangeDepth, L.rangeDepth);
      gl.uniform1f(u.u_beamW, L.beamWidth * beam.width);
      gl.uniform1f(u.u_beamB, P.beam * beam.bright * (1 + 0.8 * flare));
      gl.uniform1f(u.u_rim, sun.rim);
      gl.uniform1f(u.u_reach, sun.reach);
      gl.uniform1f(u.u_diamond, diamond.angle);
      gl.uniform1f(u.u_corona, corona);
      gl.uniform1f(u.u_glow, glow.value);
      gl.uniform1f(u.u_painted, painted ? 1 : 0);
      gl.uniform3fv(u.u_c, pal);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    },

    // Layout (and the backdrop target's size) follow ctx.size every frame.
    resize() {},

    params(changed) {
      if ("palette" in changed) palette(ctx.params.palette, pal);
    },

    dispose() {
      gl.deleteTexture(profTex);
      bgTarget.dispose();
      gl.deleteProgram(bgProg.program);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
    },
  };
}
