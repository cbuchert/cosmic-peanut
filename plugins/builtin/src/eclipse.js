// @ts-check
/**
 * Eclipse — after the cover of Bauhaus's *The Sky's Gone Out* (1982): a pure black disc inside a
 * blinding white annulus, a corona of branching, Lichtenberg-like tendrils, and marbled ink clouds
 * drifting in a black sky.
 *
 * Per frame (CPU, allocation-free, lib/eclipse.js): the 1,024-bin spectrum is wrapped around the
 * ring as a circular spectrogram — log frequency from the bottom (30 Hz) to the top (16 kHz),
 * mirrored left/right, max over the bins each of 256 sectors covers, dB with a gate and slow
 * per-frequency auto-gain (lib/spectro.js), smoothed with a fast attack and slower release — and
 * each sector's tendrils reach out as far as that frequency is loud. The waveform ripples the
 * ring's edges; bass swells the ring and shrinks the disc; onsets launch flares that travel out
 * through the corona. The swell and flares go through the flash limiter together.
 *
 * GPU: one full-screen pass in polar coordinates (shaders/eclipse/eclipse.frag) plus a 256 × 2
 * R16F texture (row 0 levels, row 1 ripple) uploaded each frame.
 */
import {
  SECTORS,
  createCorona,
  createFlares,
  createGlare,
  createRing,
  BASS_WIDEN,
  createRipple,
  effectiveMotion,
  fitEclipse,
  skyAlpha,
  tintGamma,
} from "./lib/eclipse.js";
import { createProgram, createTarget } from "./lib/gl.js";

/** Cloud fields are computed at 1/CLOUD_DIV of the canvas width and height. */
const CLOUD_DIV = 3;

/** How far (composition units) a full-level sector's tendrils reach past the ring at Reach 1. */
const REACH = 0.45;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/eclipse/";
  const [vs, noise, fs, cloudFs] = await Promise.all(
    ["fullscreen.vert", "noise.glsl", "eclipse.frag", "clouds.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const inc = (/** @type {string} */ src) => src.replace("// #include noise", noise);
  const prog = createProgram(gl, vs, inc(fs), dir + "eclipse.frag");
  const cloudProg = createProgram(gl, vs, inc(cloudFs), dir + "clouds.frag");
  const u = prog.u;
  const cu = cloudProg.u;
  // Cloud fields at 1/CLOUD_DIV of the canvas resolution (smooth; edges are cut at full res).
  const fields = createTarget(gl);
  const vao = gl.createVertexArray();

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, SECTORS, 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const upload = new Float32Array(SECTORS * 2);

  const corona = createCorona();
  const ripple = createRipple();
  const ring = createRing();
  const flares = createFlares();
  const glare = createGlare();
  const flareOut = new Float32Array(flares.data.length);
  const layout = { cx: 0, cy: 0, radius: 1 };
  const mo = { rotation: 0, reactivity: 1, drift: 1 };
  const gamma = new Float32Array(3);
  let rot = 0;
  let clock = 0;
  let mid = 0;

  return {
    frame(audio, time) {
      const dt = time.dt;
      const p = ctx.params;
      effectiveMotion(Number(p.rotation), Number(p.reactivity), ctx.reduceMotion, mo);
      const react = mo.reactivity;

      corona.step(audio.spectrum, audio.sampleRate, dt);
      ripple.step(audio.waveform, dt);
      ring.step(audio.bassAtt, dt, react, Number(p.thickness));
      flares.step(audio.onset, audio.onsetStrength, dt, react);
      glare.step(ring.swell, flares.data, dt, ctx.reduceFlashing);
      const k = glare.scale;
      for (let i = 0; i < flareOut.length; i += 2) {
        flareOut[i] = flares.data[i];
        flareOut[i + 1] = flares.data[i + 1] * k;
      }
      upload.set(corona.levels, 0);
      upload.set(ripple.out, SECTORS);

      const mt = Math.min(1, Math.max(0, (audio.midAtt - 0.5) / 1.5)) || 0;
      mid += (mt - mid) * (1 - Math.exp(-dt / 0.6));
      rot = (rot + mo.rotation * dt) % (2 * Math.PI);
      clock = (clock + mo.drift * dt) % 1000;
      // The limiter may hold back the swell: shrink its share of the ring's width with it.
      const swell = ring.swell * k;
      const outer = ring.disc + (ring.outer - ring.disc) * ((1 + BASS_WIDEN * swell) / (1 + BASS_WIDEN * ring.swell));

      const { width: w, height: h } = ctx.size;
      fitEclipse(w, h, layout);
      tintGamma(p.tint, gamma);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      const clouds = Number(p.clouds);
      if (clouds > 0) {
        const fw = Math.max(1, Math.ceil(w / CLOUD_DIV));
        const fh = Math.max(1, Math.ceil(h / CLOUD_DIV));
        if (fields.width !== fw || fields.height !== fh) fields.resize(fw, fh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fields.fbo);
        gl.viewport(0, 0, fw, fh);
        gl.useProgram(cloudProg.program);
        gl.uniform2f(cu.u_res, w, h);
        gl.uniform2f(cu.u_center, layout.cx, layout.cy);
        gl.uniform1f(cu.u_radius, layout.radius);
        gl.uniform1f(cu.u_outer, outer);
        gl.uniform1f(cu.u_time, clock);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SECTORS, 2, gl.RED, gl.FLOAT, upload);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fields.tex);
      gl.useProgram(prog.program);
      gl.uniform1i(u.u_lev, 0);
      gl.uniform1i(u.u_fields, 1);
      gl.uniform2f(u.u_res, w, h);
      gl.uniform2f(u.u_center, layout.cx, layout.cy);
      gl.uniform1f(u.u_radius, layout.radius);
      gl.uniform1f(u.u_disc, ring.disc);
      gl.uniform1f(u.u_outer, outer);
      gl.uniform1f(u.u_swell, swell);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_time, clock);
      gl.uniform1f(u.u_reach, REACH * Number(p.reach) * Math.min(1.5, react));
      gl.uniform1f(u.u_clouds, clouds);
      gl.uniform1f(u.u_mid, mid);
      gl.uniform2fv(u.u_flares, flareOut);
      gl.uniform3f(u.u_gamma, gamma[0], gamma[1], gamma[2]);
      gl.uniform1f(u.u_sky, skyAlpha(p.sky));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    dispose() {
      gl.deleteTexture(tex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(cloudProg.program);
      fields.dispose();
    },
  };
}
