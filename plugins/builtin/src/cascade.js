// @ts-check
/**
 * Cascade — a waterfall simulated on the GPU and seeded by the audio waveform (`webgl2`).
 *
 * Each frame:
 *  1. The newest waveform becomes a 256-texel flow seed across the lip (|w| point-resampled,
 *     smoothed over a few frames, auto-gained, scaled by the bass surge) plus its inverse CDF
 *     (lib/cascade.js, unit-tested). Both go to the GPU as R32F rows.
 *  2. Particle state lives in two ping-pong pairs of float textures (position/velocity and
 *     age/kind/weight/life). A fixed 120 Hz step (dt accumulator, ≤ 4 substeps) applies gravity,
 *     drag and lateral turbulence, respawns dead particles at the lip where the seed is strong,
 *     and turns water hitting the pool into short-lived spray.
 *  3. Particles are drawn as velocity-aligned streaks (instanced quads pulling state straight from
 *     the texture: no CPU readback) additively into a float target.
 *  4. Spray also splats into a quarter-res mist buffer that drifts, decays and is blurred.
 *  5. Composite: water over mist, tone-mapped, premultiplied with alpha = max(r, g, b).
 *
 * Layout (lib/cascade.js `layout`, unit-tested): by default the lip spans the whole window just
 * above the top edge (a little past each side, so no gap opens at the edges) and the pool sits on
 * the bottom edge, for any aspect; the width/height params narrow and shorten it as fractions.
 * Line width, mist blob size and a brightness compensation follow the canvas size.
 *
 * State textures are RGBA32F when EXT_color_buffer_float is available (every WebGL2 GPU on macOS);
 * the fallback is RGBA16F via EXT_color_buffer_half_float (positions then quantise to ~1/2048 of
 * the screen height, still sub-pixel near the top); without either, create() throws a clear error.
 * frame() allocates nothing.
 */
import {
  buildInverseCdf,
  createEnvelopes,
  createSeed,
  createStepper,
  layout,
  motionParams,
  paletteStops,
  stateSize,
} from "./lib/cascade.js";
import { createProgram, createTarget } from "./lib/gl.js";

const SEED_N = 256;
const INV_N = 512;
const SIM_HZ = 120;
const MAX_STEPS = 4;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/cascade/";
  const names = [
    "fullscreen.vert",
    "update.frag",
    "water.vert",
    "water.frag",
    "mist.vert",
    "mist.frag",
    "advect.frag",
    "blur.frag",
    "composite.frag",
  ];
  const [fullVs, updateFs, waterVs, waterFs, mistVs, mistFs, advectFs, blurFs, compFs] = await Promise.all(
    names.map((f) => ctx.assets.text(dir + f)),
  );

  // Float render targets for particle state (see header).
  const f32 = gl.getExtension("EXT_color_buffer_float");
  const f16 = f32 ? null : gl.getExtension("EXT_color_buffer_half_float");
  if (!f32 && !f16) throw new Error("Cascade needs float render targets (EXT_color_buffer_float)");
  const stateFormat = f32 ? gl.RGBA32F : gl.RGBA16F;

  const update = createProgram(gl, fullVs, updateFs, dir + "update.frag");
  const water = createProgram(gl, waterVs, waterFs, dir + "water.frag");
  const mist = createProgram(gl, mistVs, mistFs, dir + "mist.frag");
  const advect = createProgram(gl, fullVs, advectFs, dir + "advect.frag");
  const blur = createProgram(gl, fullVs, blurFs, dir + "blur.frag");
  const comp = createProgram(gl, fullVs, compFs, dir + "composite.frag");
  const programs = [update, water, mist, advect, blur, comp];

  const vao = gl.createVertexArray(); // attribute-less drawing still wants a bound VAO
  const waterTarget = createTarget(gl);
  const mistCur = createTarget(gl);
  const mistTmp = createTarget(gl);
  const mistOut = createTarget(gl);

  /** @param {number} internal @param {number} w */
  function rowTexture(internal, w) {
    const t = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  const seedTex = rowTexture(gl.R32F, SEED_N);
  const invTex = rowTexture(gl.R32F, INV_N);

  // --- particle state: two sides, each two float textures behind one MRT framebuffer ----------
  /** @typedef {{ fbo: WebGLFramebuffer, t0: WebGLTexture, t1: WebGLTexture }} StateSide */
  /** @type {StateSide[]} */
  let sides = [];
  let cur = 0;
  let count = 0;
  let stateW = 0;
  let stateH = 0;

  /** @param {number} w @param {number} h */
  function stateTexture(w, h) {
    const t = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, stateFormat, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }

  function freeState() {
    for (const s of sides) {
      gl.deleteFramebuffer(s.fbo);
      gl.deleteTexture(s.t0);
      gl.deleteTexture(s.t1);
    }
    sides = [];
  }

  /** (Re)allocate state for the density param; every particle starts dead, waiting at the lip. */
  function allocState() {
    freeState();
    const size = stateSize(ctx.params.density);
    count = size.count;
    stateW = size.width;
    stateH = size.height;
    for (let i = 0; i < 2; i++) {
      const t0 = stateTexture(stateW, stateH);
      const t1 = stateTexture(stateW, stateH);
      const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t1, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
        throw new Error(`Cascade: particle state framebuffer incomplete (0x${status.toString(16)})`);
      }
      gl.clearBufferfv(gl.COLOR, 0, zero4y);
      gl.clearBufferfv(gl.COLOR, 1, zero4);
      sides.push({ fbo, t0, t1 });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cur = 0;
  }
  const zero4 = new Float32Array(4);
  const zero4y = new Float32Array([0, -2, 0, 0]);

  function resize() {
    const { width: w, height: h } = ctx.size;
    waterTarget.resize(w, h);
    const { mistW: mw, mistH: mh } = layout(w, h, ctx.params, L);
    mistCur.resize(mw, mh);
    mistTmp.resize(mw, mh);
    mistOut.resize(mw, mh);
    // createTarget clears to opaque black; the mist feedback must start empty in every channel.
    for (const t of [mistCur, mistTmp, mistOut]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const seed = createSeed(SEED_N);
  const inv = new Float32Array(INV_N);
  const env = createEnvelopes();
  const stepper = createStepper(SIM_HZ, MAX_STEPS);
  const stops = new Float32Array(12);
  const mistColor = new Float32Array(3);
  const motion = { spray: 0, turbulence: 0 };
  /** @type {Partial<import('./lib/cascade.js').Layout>} */
  const L = {};
  let simStep = 0;
  let simTime = 0;
  let clock = 0;

  function applyParams() {
    paletteStops(ctx.params.palette, stops);
    // Mist takes the palette's pale stop, a little desaturated.
    for (let i = 0; i < 3; i++) mistColor[i] = 0.55 * stops[6 + i] + 0.25 * stops[9 + i];
  }

  allocState();
  applyParams();
  resize();

  return {
    frame(audio, time) {
      const { width: w, height: h } = ctx.size;
      const dt = time.dt;
      const aspect = w / h;
      const p = ctx.params;
      clock += dt;
      motionParams(p, ctx.reduceMotion, motion);

      // 1. Audio → seed and lip distribution.
      env.step(audio, dt, ctx.reduceFlashing);
      seed.update(audio.waveform, dt, env.surge);
      buildInverseCdf(seed.values, inv);
      gl.bindTexture(gl.TEXTURE_2D, seedTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEED_N, 1, gl.RED, gl.FLOAT, seed.values);
      gl.bindTexture(gl.TEXTURE_2D, invTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, INV_N, 1, gl.RED, gl.FLOAT, inv);

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // 2. Fixed-step particle update.
      const flow = Number(p.flow);
      const stepDt = 1 / SIM_HZ;
      // Respawn rate per dead particle per second: total flow over the lip (seed mean already
      // carries the bass surge) plus the onset pulse.
      const rate = flow * (14 * seed.mean + 5 * env.pulse * (0.3 + seed.mean));
      // Every particle starts dead; ramp the first 1.5 s so the lip doesn't dump them all at once.
      const spawn = (1 - Math.exp(-rate * stepDt)) * Math.min(1, clock / 1.5);
      // Full-window layout in height units (lib/cascade.js): lip across the top, pool on the bottom.
      const lay = layout(w, h, p, L);
      const steps = stepper.step(dt);
      if (steps > 0) {
        gl.useProgram(update.program);
        const u = update.u;
        gl.viewport(0, 0, stateW, stateH);
        gl.uniform1i(u.u_s0, 0);
        gl.uniform1i(u.u_s1, 1);
        gl.uniform1i(u.u_seed, 2);
        gl.uniform1i(u.u_inv, 3);
        gl.uniform1i(u.u_count, count);
        gl.uniform1f(u.u_dt, stepDt);
        gl.uniform1f(u.u_spawn, spawn);
        gl.uniform1f(u.u_gravity, 1.7 * Number(p.gravity));
        gl.uniform1f(u.u_turb, motion.turbulence);
        gl.uniform1f(u.u_spray, motion.spray);
        gl.uniform1f(u.u_pulse, env.pulse);
        gl.uniform1f(u.u_lipY, lay.lipY);
        gl.uniform1f(u.u_lipHalf, lay.lipHalf);
        gl.uniform1f(u.u_poolY, lay.poolY);
        gl.uniform1f(u.u_floorY, lay.floorY);
        gl.uniform1f(u.u_killX, lay.killX);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, seedTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, invTex);
        for (let s = 0; s < steps; s++) {
          const src = sides[cur];
          const dst = sides[cur ^ 1];
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.t0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, src.t1);
          gl.uniform1ui(u.u_step, simStep++ >>> 0);
          simTime += stepDt;
          gl.uniform1f(u.u_time, simTime);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          cur ^= 1;
        }
      }
      const state = sides[cur];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.t0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, state.t1);

      // 3. Water streaks, additive into the float target.
      gl.bindFramebuffer(gl.FRAMEBUFFER, waterTarget.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(water.program);
      gl.uniform1i(water.u.u_s0, 0);
      gl.uniform1i(water.u.u_s1, 1);
      gl.uniform1i(water.u.u_count, count);
      gl.uniform1f(water.u.u_aspect, aspect);
      gl.uniform2f(water.u.u_px, 1 / h, 1 / h);
      gl.uniform1f(water.u.u_streak, lay.streak);
      gl.uniform1f(water.u.u_width, lay.lineWidth);
      gl.uniform3fv(water.u.u_stops, stops);
      // Denser settings draw more streaks: keep total brightness roughly constant across them.
      gl.uniform1f(water.u.u_gain, 0.7 * lay.gain * Math.sqrt(32768 / count) * (1 + 0.35 * env.pulse));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

      // 4. Mist: advect last frame's mist, splat spray into it, blur twice.
      const mistAmt = Number(p.mist);
      const k = dt * 60;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mistCur.fbo);
      gl.viewport(0, 0, mistCur.width, mistCur.height);
      gl.useProgram(advect.program);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, mistOut.tex);
      gl.uniform1i(advect.u.u_prev, 4);
      gl.uniform1f(advect.u.u_time, clock);
      gl.uniform1f(advect.u.u_rise, 0.0022 * k);
      gl.uniform1f(advect.u.u_decay, 0.972 ** k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.BLEND);
      gl.useProgram(mist.program);
      gl.uniform1i(mist.u.u_s0, 0);
      gl.uniform1i(mist.u.u_s1, 1);
      gl.uniform1i(mist.u.u_count, count);
      gl.uniform1f(mist.u.u_aspect, aspect);
      gl.uniform1f(mist.u.u_poolY, lay.poolY);
      gl.uniform1f(mist.u.u_size, Math.max(3, lay.mistSize));
      gl.uniform1f(mist.u.u_gain, 0.02 * k * Math.sqrt(32768 / count));
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
      gl.useProgram(blur.program);
      gl.uniform1i(blur.u.u_src, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mistTmp.fbo);
      gl.bindTexture(gl.TEXTURE_2D, mistCur.tex);
      gl.uniform2f(blur.u.u_dir, 1 / mistCur.width, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mistOut.fbo);
      gl.bindTexture(gl.TEXTURE_2D, mistTmp.tex);
      gl.uniform2f(blur.u.u_dir, 0, 1 / mistCur.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 5. Composite to the transparent, premultiplied canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(comp.program);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, waterTarget.tex);
      gl.uniform1i(comp.u.u_water, 5);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, mistOut.tex);
      gl.uniform1i(comp.u.u_mist, 4);
      gl.uniform3fv(comp.u.u_mistColor, mistColor);
      gl.uniform1f(comp.u.u_mistGain, mistAmt * 1.2);
      gl.uniform1f(comp.u.u_exposure, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    },

    resize,

    params(changed) {
      if ("density" in changed) allocState();
      applyParams();
    },

    dispose() {
      freeState();
      for (const t of [waterTarget, mistCur, mistTmp, mistOut]) t.dispose();
      gl.deleteTexture(seedTex);
      gl.deleteTexture(invTex);
      gl.deleteVertexArray(vao);
      for (const pr of programs) gl.deleteProgram(pr.program);
    },
  };
}
