// @ts-check
/**
 * Blaze — a real-time fire simulation fed by the music, for the `webgl2` renderer.
 *
 * Per frame (CPU, allocation-free): build a 256-texel fuel line (lib/fuel.js). With Feed =
 * "spectrum" (default) the 64 bands are auto-gained per band, gated and expanded (Reactivity),
 * and mirrored across the line (bass the central column, highs at both edges), with the waveform
 * as a ±20 % flicker; each band's attacks throw a jet (upward velocity + heat at that band's x,
 * ~300 ms). Feed = "waveform" is the original feed: the resampled waveform × a slow auto-gain.
 * Then step the music drive (bass stoke + onset flare, flash-limited, × Reactivity) and run a
 * fixed 120 Hz simulation on a grid of canvas × Detail:
 *   curl      vorticity of the velocity field
 *   velocity  self-advection, buoyancy, curl-noise turbulence, vorticity confinement, jets
 *   scalar    advect temperature + fuel, feed fuel from the seed along the bottom, jet heat, burn, cool
 * and composite the temperature through the palette ramp onto the transparent canvas.
 *
 * Sim targets are RGBA16F when the GPU can render to half floats (EXT_color_buffer_float or
 * EXT_color_buffer_half_float). Without either they fall back to RGBA8: velocity is stored
 * offset-encoded (±4 heights/s in 8 bits), temperature clamps at 1 and vorticity confinement is
 * off, so the fire is coarser and calmer but still works.
 */
import { createDrive, createStepper, fillRampLut, motion, simSize } from "./lib/fire.js";
import { createFeed } from "./lib/fuel.js";
import { createProgram } from "./lib/gl.js";

const SEED = 256;
const BANDS = 64;
const SIM_RATE = 120; // sim steps per second
const MAX_STEPS = 4;
const JACOBI = 8; // even, so the warm start stays in pres[0]
const JET_VEL = 3.6; // upward speed a full-strength jet drives its column to, heights/s
const JET_HEAT = 1.5; // heat a full-strength jet adds at its root

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/blaze/";
  const files = ["fullscreen.vert", "noise.glsl", "curl.frag", "velocity.frag", "scalar.frag", "composite.frag"];
  files.push("divergence.frag", "pressure.frag", "project.frag");
  const [vs, noise, curlFs, velFs, scalFs, compFs, divFs, presFs, projFs] = await Promise.all(
    files.map((f) => ctx.assets.text(dir + f)),
  );
  const inc = (/** @type {string} */ src) => src.replace("// #include noise", noise);
  const curlP = createProgram(gl, vs, curlFs, dir + "curl.frag");
  const velP = createProgram(gl, vs, inc(velFs), dir + "velocity.frag");
  const scalP = createProgram(gl, vs, inc(scalFs), dir + "scalar.frag");
  const compP = createProgram(gl, vs, inc(compFs), dir + "composite.frag");
  const divP = createProgram(gl, vs, divFs, dir + "divergence.frag");
  const presP = createProgram(gl, vs, presFs, dir + "pressure.frag");
  const projP = createProgram(gl, vs, projFs, dir + "project.frag");

  const half =
    Boolean(gl.getExtension("EXT_color_buffer_float")) || Boolean(gl.getExtension("EXT_color_buffer_half_float"));
  // stored = v * VENC[0] + VENC[1]
  const VENC_X = half ? 1 : 1 / 8;
  const VENC_Y = half ? 0 : 0.5;

  const vao = gl.createVertexArray();

  /** A sim texture + framebuffer. @param {boolean} linear */
  function target(linear) {
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, fbo };
  }
  const scal = [target(true), target(true)];
  const vel = [target(true), target(true)];
  const curl = target(false);
  const div = target(false);
  const pres = [target(false), target(false)];
  let sw = 0;
  let sh = 0;
  let cur = 0; // scalar ping-pong
  let vcur = 0; // velocity ping-pong

  /** (Re)allocate one target and clear it to `r, g`. @param {{tex: WebGLTexture, fbo: WebGLFramebuffer}} t @param {number} r @param {number} g */
  function alloc(t, r, g, one = false) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (one) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, sw, sh, 0, gl.RED, gl.HALF_FLOAT, null);
    else if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, sw, sh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.clearColor(r, g, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function resize() {
    const s = simSize(ctx.size.width, ctx.size.height, Number(ctx.params.detail));
    if (s.width === sw && s.height === sh) return;
    sw = s.width;
    sh = s.height;
    for (const t of scal) alloc(t, 0, 0);
    for (const t of vel) alloc(t, VENC_Y, VENC_Y);
    alloc(curl, 0, 0); // unused without half floats, but kept complete for the sampler
    if (half) for (const t of [div, ...pres]) alloc(t, 0, 0, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Fuel line: 256×1 RG16F (r = fuel, g = jet strength), linear across the bottom of the sim.
  const seedBuf = new Float32Array(SEED * 2);
  const seedTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, seedTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16F, SEED, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Palette ramp: 256×1 RGBA8, premultiplied.
  const lut = new Uint8Array(256 * 4);
  const lutTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function applyPalette() {
    fillRampLut(String(ctx.params.palette), lut);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  const feed = createFeed(SEED, BANDS);
  const drive = createDrive();
  const stepper = createStepper(SIM_RATE, MAX_STEPS);
  const mo = { turbulence: 1, speed: 1, reactivity: 1 };
  let clock = 0;

  applyPalette();
  resize();

  /** Draw a fullscreen pass into `t` (or the canvas when null). @param {{fbo: WebGLFramebuffer} | null} t */
  function into(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  }
  /** @param {number} unit @param {WebGLTexture | null} tex */
  function bind(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  return {
    frame(audio, time) {
      const p = ctx.params;
      motion(p, ctx.reduceMotion, mo);
      const intensity = Number(p.intensity);
      const height = Number(p.height);

      // 1. Audio → fuel line + jets (CPU, no allocation).
      feed.step(audio, time.dt, String(p.feed), mo.reactivity, ctx.reduceFlashing);
      const fuel = feed.fuel;
      const jet = feed.jet;
      for (let i = 0; i < SEED; i++) {
        seedBuf[2 * i] = fuel[i];
        seedBuf[2 * i + 1] = jet[i];
      }
      bind(2, seedTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEED, 1, gl.RG, gl.FLOAT, seedBuf);

      drive.step(audio, time.dt, ctx.reduceFlashing, mo.reactivity);
      const react = mo.reactivity > 0 ? Math.min(2, mo.reactivity) : 0;
      const boost = drive.boost;

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, sw, sh);
      const aspect = sw / sh;
      const dtSim = (1 / SIM_RATE) * mo.speed;
      const n = stepper.step(time.dt);

      for (let k = 0; k < n; k++) {
        clock = (clock + dtSim) % 1000;
        const s0 = scal[cur];
        const s1 = scal[cur ^ 1];
        const v0 = vel[vcur];
        const v1 = vel[vcur ^ 1];

        // Vorticity.
        if (half) {
          into(curl);
          gl.useProgram(curlP.program);
          bind(0, v0.tex);
          gl.uniform1i(curlP.u.u_vel, 0);
          gl.uniform2f(curlP.u.u_venc, VENC_X, VENC_Y);
          gl.uniform1f(curlP.u.u_inv, sh);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // Velocity.
        into(v1);
        gl.useProgram(velP.program);
        bind(0, v0.tex);
        bind(1, s0.tex);
        bind(3, curl.tex);
        const u = velP.u;
        gl.uniform1i(u.u_vel, 0);
        gl.uniform1i(u.u_scal, 1);
        gl.uniform1i(u.u_seed, 2);
        gl.uniform1i(u.u_curl, 3);
        gl.uniform1f(u.u_jetVel, JET_VEL);
        gl.uniform2f(u.u_venc, VENC_X, VENC_Y);
        gl.uniform1f(u.u_aspect, aspect);
        gl.uniform1f(u.u_dt, dtSim);
        gl.uniform1f(u.u_time, clock);
        gl.uniform1f(u.u_buoy, 3);
        gl.uniform1f(u.u_turb, 2.5 * mo.turbulence);
        gl.uniform1f(u.u_vort, half ? 10 * mo.turbulence : 0);
        gl.uniform1f(u.u_damp, 2.5);
        gl.uniform1f(u.u_texelH, 1 / sh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        let vOut = v1;

        // Pressure projection (half floats only: pressure is signed): divergence, a few Jacobi
        // iterations warm-started from the previous step, subtract the gradient back into v0.
        if (half) {
          into(div);
          gl.useProgram(divP.program);
          bind(0, v1.tex);
          gl.uniform1i(divP.u.u_vel, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.useProgram(presP.program);
          gl.uniform1i(presP.u.u_p, 0);
          gl.uniform1i(presP.u.u_div, 1);
          bind(1, div.tex);
          for (let j = 0; j < JACOBI; j++) {
            into(pres[(j + 1) & 1]);
            bind(0, pres[j & 1].tex);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          }
          into(v0);
          gl.useProgram(projP.program);
          bind(0, v1.tex);
          bind(1, pres[JACOBI & 1].tex);
          gl.uniform1i(projP.u.u_vel, 0);
          gl.uniform1i(projP.u.u_p, 1);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          vOut = v0;
        } else {
          vcur ^= 1;
        }

        // Temperature + fuel.
        into(s1);
        gl.useProgram(scalP.program);
        bind(0, s0.tex);
        bind(1, vOut.tex);
        const w = scalP.u;
        gl.uniform1i(w.u_scal, 0);
        gl.uniform1i(w.u_vel, 1);
        gl.uniform1i(w.u_seed, 2);
        gl.uniform2f(w.u_venc, VENC_X, VENC_Y);
        gl.uniform2f(w.u_texel, 1 / sw, 1 / sh);
        gl.uniform1f(w.u_aspect, aspect);
        gl.uniform1f(w.u_dt, dtSim);
        gl.uniform1f(w.u_time, clock);
        gl.uniform1f(w.u_inject, 2.6 * intensity * (0.7 + 0.6 * boost));
        gl.uniform1f(w.u_ember, 0.08 * intensity);
        gl.uniform1f(w.u_jetHeat, JET_HEAT * intensity);
        gl.uniform1f(w.u_jetVel, JET_VEL);
        // The flash-limited share of the boost that isn't bass stoke: the onset flare.
        const flare = boost - 0.5 * react * drive.stoke;
        gl.uniform1f(w.u_flare, 0.6 * intensity * (flare > 0 ? flare : 0));
        gl.uniform1f(w.u_cool, 9 / Math.max(0.3, height));
        gl.uniform1f(w.u_burn, 3);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        cur ^= 1;
      }

      // Composite onto the transparent canvas.
      const { width: cw, height: ch } = ctx.size;
      into(null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(compP.program);
      bind(0, scal[cur].tex);
      bind(1, lutTex);
      const c = compP.u;
      gl.uniform1i(c.u_scal, 0);
      gl.uniform1i(c.u_lut, 1);
      gl.uniform2f(c.u_simTexel, 1 / sw, 1 / sh);
      gl.uniform1f(c.u_aspect, cw / ch);
      gl.uniform1f(c.u_time, clock);
      gl.uniform1f(c.u_exposure, 1 + 0.3 * boost);
      gl.uniform1f(c.u_glow, Number(p.glow));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    resize,

    params(changed) {
      if ("palette" in changed) applyPalette();
      if ("detail" in changed) resize();
    },

    dispose() {
      for (const t of [...scal, ...vel, curl, div, ...pres]) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
      gl.deleteTexture(seedTex);
      gl.deleteTexture(lutTex);
      gl.deleteVertexArray(vao);
      for (const pr of [curlP, velP, scalP, compP, divP, presP, projP]) gl.deleteProgram(pr.program);
    },
  };
}
