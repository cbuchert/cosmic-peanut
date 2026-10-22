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
 * The background follows the music too: the ink clouds orbit the eclipse faster when it's loud
 * and surge on beats; they're born, grow and dissolve on a formation clock that runs with the
 * energy; they billow out near the spectrum's loud angles and thin near quiet ones; strong beats
 * spawn new billows at the ring's edge that drift outward; sky pulses push a shockwave through
 * them and light faint rays in the black sky; the bass brightens them and the ring's rim light on
 * them pulses on beats (all flash-limited with the ring). Below a waterline (Water: low / mid) a
 * dark sea mirrors it all: the waveform keeps small ripples running, the bass rolls long swells
 * in and stretches the sun's reflection into a streak, and beats drop rings that spread across it.
 *
 * GPU: a 256 × 3 R16F texture (row 0 levels, row 1 ripple, row 2 cloud bias) uploaded each frame;
 * the marbled clouds' smooth fields at a third of the resolution (shaders/eclipse/clouds.frag; at
 * full res the clouds tripled the frame's GPU time); then one full-screen pass in polar
 * coordinates (shaders/eclipse/eclipse.frag) draws the disc, ring, dendrite corona (procedural
 * branching trees in a domain-warped space) and cuts the clouds' crisp edges and streaks from the
 * fields — straight to the canvas, or with water into a canvas-sized target (skipping the rows
 * under the waterline) that shaders/eclipse/water.frag copies above the line and mirrors below.
 */
import {
  SECTORS,
  createCorona,
  createFlares,
  createGlare,
  createRing,
  BASS_WIDEN,
  cloudThreshold,
  createRipple,
  createFlow,
  createCloudBias,
  createCloudLight,
  createPulses,
  createBillows,
  createWater,
  backgroundDrive,
  effectiveMotion,
  fitEclipse,
  skyAlpha,
  tintGamma,
} from "./lib/eclipse.js";
import { createProgram, createTarget } from "./lib/gl.js";

/** Cloud fields are computed at 1/CLOUD_DIV of the canvas width and height. */
const CLOUD_DIV = 3;

/** How far (composition units) a full-level sector's tendrils reach past the ring at Reach 1. */
const REACH = 0.6;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/eclipse/";
  const [vs, noise, fs, cloudFs, waterFs] = await Promise.all(
    ["fullscreen.vert", "noise.glsl", "eclipse.frag", "clouds.frag", "water.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const inc = (/** @type {string} */ src) => src.replace("// #include noise", noise);
  const prog = createProgram(gl, vs, inc(fs), dir + "eclipse.frag");
  const cloudProg = createProgram(gl, vs, inc(cloudFs), dir + "clouds.frag");
  const waterProg = createProgram(gl, vs, waterFs, dir + "water.frag");
  const u = prog.u;
  const cu = cloudProg.u;
  const wu = waterProg.u;
  // Cloud fields at 1/CLOUD_DIV of the canvas resolution (smooth; edges are cut at full res).
  const fields = createTarget(gl);
  fields.resize(1, 1); // complete before the first cloud pass
  // With water: the scene, canvas-sized, for water.frag to copy and mirror.
  const scene = createTarget(gl);
  scene.resize(1, 1);
  const vao = gl.createVertexArray();

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, SECTORS, 3);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const upload = new Float32Array(SECTORS * 3);

  const corona = createCorona();
  const ripple = createRipple();
  const ring = createRing();
  const flares = createFlares();
  const glare = createGlare();
  const flareOut = new Float32Array(flares.data.length);
  const flow = createFlow();
  const bias = createCloudBias();
  const light = createCloudLight();
  const pulses = createPulses();
  const pulseOut = new Float32Array(pulses.data.length);
  const billows = createBillows();
  const water = createWater();
  const layout = { cx: 0, cy: 0, radius: 1, horizon: 0 };
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
      flow.step(audio.rms, audio.bassAtt, audio.onset, audio.onsetStrength, dt, react, mo.drift);
      // The background responds in proportion to the energy: calm when quiet, turbulent when loud.
      // (Reduce motion: gentler still — drift is 0.4 then, so this is 0.7.)
      const drive = backgroundDrive(react, flow.energy) * (0.5 + 0.5 * mo.drift);
      bias.step(corona.levels, dt, drive);
      light.step(audio.bassAtt, audio.rms, audio.onset, audio.onsetStrength, dt, drive);
      pulses.step(audio.onset, audio.onsetStrength, dt, drive);
      billows.step(audio.onset, audio.onsetStrength, corona.levels, dt, drive);
      water.step(audio.waveform, audio.bassAtt, audio.onset, audio.onsetStrength, dt, drive);
      const waterOn = String(p.water) !== "off";
      // The background's brightening counts toward the frame's flash budget with the ring's.
      let topPulse = 0;
      for (let i = 1; i < pulses.data.length; i += 2) if (pulses.data[i] > topPulse) topPulse = pulses.data[i];
      const extra = 0.4 * light.bright + 0.3 * light.rim + 0.15 * topPulse + (waterOn ? 0.2 * water.streak : 0);
      glare.step(ring.swell, flares.data, dt, ctx.reduceFlashing, extra);
      const k = glare.scale;
      for (let i = 0; i < flareOut.length; i += 2) {
        flareOut[i] = flares.data[i];
        flareOut[i + 1] = flares.data[i + 1] * k;
      }
      for (let i = 0; i < pulseOut.length; i += 2) {
        pulseOut[i] = pulses.data[i];
        pulseOut[i + 1] = pulses.data[i + 1] * k;
      }
      upload.set(corona.levels, 0);
      upload.set(ripple.out, SECTORS);
      upload.set(bias.out, 2 * SECTORS);

      const mt = Math.min(1, Math.max(0, (audio.midAtt - 0.5) / 1.5)) || 0;
      mid += (mt - mid) * (1 - Math.exp(-dt / 0.2));
      rot = (rot + mo.rotation * dt) % (2 * Math.PI);
      clock = (clock + mo.drift * dt) % 1000;
      // The limiter may hold back the swell: shrink its share of the ring's width with it.
      const swell = ring.swell * k;
      const outer = ring.disc + (ring.outer - ring.disc) * ((1 + BASS_WIDEN * swell) / (1 + BASS_WIDEN * ring.swell));

      const { width: w, height: h } = ctx.size;
      fitEclipse(w, h, layout, waterOn ? p.water : "off");
      tintGamma(p.tint, gamma);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      const clouds = Number(p.clouds);
      // Resize targets first: resize() binds their texture to the active unit.
      const fw = Math.max(1, Math.ceil(w / CLOUD_DIV));
      const fh = Math.max(1, Math.ceil(h / CLOUD_DIV));
      if (clouds > 0 && (fields.width !== fw || fields.height !== fh)) fields.resize(fw, fh);
      if (waterOn && (scene.width !== w || scene.height !== h)) scene.resize(w, h);
      // Unit 1 is read by the passes after the cloud pass; never leave a render target on it.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SECTORS, 3, gl.RED, gl.FLOAT, upload);
      const th = cloudThreshold(clouds, mid, flow.energy);
      if (clouds > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fields.fbo);
        gl.viewport(0, 0, fw, fh);
        gl.useProgram(cloudProg.program);
        gl.uniform2f(cu.u_res, w, h);
        gl.uniform2f(cu.u_center, layout.cx, layout.cy);
        gl.uniform1f(cu.u_radius, layout.radius);
        gl.uniform1f(cu.u_outer, outer);
        gl.uniform1f(cu.u_time, clock);
        gl.uniform1f(cu.u_th, th);
        gl.uniform1f(cu.u_angle, flow.angle);
        gl.uniform1f(cu.u_evolve, flow.evolve);
        gl.uniform1f(cu.u_kick, Math.min(1.5, flow.surge * drive));
        gl.uniform2fv(cu.u_pulses, pulses.data);
        gl.uniform4fv(cu.u_billows, billows.data);
        gl.uniform1i(cu.u_lev, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      if (waterOn) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      } else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fields.tex);
      gl.useProgram(prog.program);
      gl.uniform1i(u.u_lev, 0);
      gl.uniform1i(u.u_fields, 1);
      gl.uniform2f(u.u_res, w, h);
      gl.uniform1f(u.u_fieldTexel, 1 / fields.width);
      gl.uniform1f(u.u_th, th);
      gl.uniform2f(u.u_center, layout.cx, layout.cy);
      gl.uniform1f(u.u_radius, layout.radius);
      gl.uniform1f(u.u_disc, ring.disc);
      gl.uniform1f(u.u_outer, outer);
      gl.uniform1f(u.u_swell, swell);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_time, clock);
      gl.uniform1f(u.u_reach, REACH * Number(p.reach) * Math.min(1.5, react));
      gl.uniform1f(u.u_clouds, clouds);
      gl.uniform2fv(u.u_flares, flareOut);
      gl.uniform3f(u.u_gamma, gamma[0], gamma[1], gamma[2]);
      gl.uniform1f(u.u_sky, skyAlpha(p.sky));
      gl.uniform2fv(u.u_pulses, pulseOut);
      gl.uniform1f(u.u_bright, light.bright * k);
      gl.uniform1f(u.u_rim, light.rim * k);
      gl.uniform1f(u.u_horizon, layout.horizon);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (waterOn) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, scene.tex);
        gl.useProgram(waterProg.program);
        gl.uniform1i(wu.u_scene, 1);
        gl.uniform1i(wu.u_lev, 0);
        gl.uniform2f(wu.u_res, w, h);
        gl.uniform1f(wu.u_horizon, layout.horizon);
        gl.uniform1f(wu.u_cx, layout.cx);
        gl.uniform1f(wu.u_ringR, outer * layout.radius);
        gl.uniform1f(wu.u_chop, water.chop);
        gl.uniform1f(wu.u_swell, water.swell);
        gl.uniform1f(wu.u_roll, water.roll);
        gl.uniform1f(wu.u_streak, water.streak * k);
        gl.uniform1f(wu.u_time, clock);
        gl.uniform4fv(wu.u_rings, water.rings);
        gl.uniform3f(wu.u_gamma, gamma[0], gamma[1], gamma[2]);
        gl.uniform1f(wu.u_sky, skyAlpha(p.sky));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    },

    dispose() {
      gl.deleteTexture(tex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(cloudProg.program);
      gl.deleteProgram(waterProg.program);
      fields.dispose();
      scene.dispose();
    },
  };
}
