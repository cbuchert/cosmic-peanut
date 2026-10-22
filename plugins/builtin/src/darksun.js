// @ts-check
/**
 * Dark Sun — after Mogwai's *Every Country's Sun*: a dark sun high in an ash-to-salmon watercolour
 * sky, a glowing horizon across the middle, and hanging from it an upside-down mountain range
 * with a beam of light falling from its heart.
 *
 * The music: how loud it is (absolutely: rms in dB, smoothed) sets how alive everything is, so a
 * quiet passage stays calm and moody and a loud one is visibly alive. The bass swells the sun's
 * disc, rim and corona, while the "diamond ring" travels round the rim and spikes on every beat;
 * the corona turns faster, a halo blooms and the sun rises in the sky as the song builds (and sinks
 * toward the horizon as it falls); faint shafts of light pulse across the sky with the bass. The
 * inverted range is the live spectrum (log frequency, mirrored, bass at the centre, peaks that
 * linger); on each beat it drops (a spring jolt), the beam flares and widens, a shock runs out
 * along the horizon and a ripple spreads through the wet ground from the beam. Between beats the
 * landscape breathes on the host's beat phase. The watercolour washes flow faster and wilder with
 * energy and surge on beats; the sky warms and brightens with spectral brightness and energy (and
 * cools to ash when the music thins out); the range and beam shimmer in the dark ground.
 * Every full-frame brightness change goes through the flash limiter.
 *
 * GPU: the painted sky and ground washes (shaders/darksun/backdrop.frag) render at quarter
 * resolution into their own target — they have no fine detail, and at full resolution they were
 * most of the cost — then one full-screen pass (darksun.frag) draws everything else over them,
 * reading one N × 1 R32F texture of the range profile uploaded per frame. Pure logic lives in lib/horizon.js and lib/darksun.js and is
 * tested there. Nothing is allocated per frame.
 */
import {
  beatHit,
  createBeam,
  createBreath,
  createEnergy,
  createFlow,
  createRipples,
  createSkyTone,
  createSpike,
  createSunMood,
  reflection,
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
import { createDrop, createHorizon } from "./lib/horizon.js";

/** Columns across the range (half per side): the ridgeline's resolution. */
const N = 64;
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
  const energy = createEnergy();
  const flow = createFlow();
  const tone = createSkyTone();
  const breath = createBreath();
  const ripples = createRipples();
  const drop = createDrop();
  const spike = createSpike();
  const throb = createSpike();
  const mood = createSunMood();
  const pal = palette(ctx.params.palette, new Float32Array(PALETTES.SIZE));
  const P = resolveParams(ctx.params, ctx.reduceMotion, /** @type {any} */ ({}));
  const L = layout(ctx.size.width, ctx.size.height, P, /** @type {any} */ ({}));

  return {
    frame(audio, time) {
      const dt = time.dt;
      const { width: w, height: h } = ctx.size;
      resolveParams(ctx.params, ctx.reduceMotion, P);
      const r = P.reactivity;

      const e = energy.step(audio.rms, dt);
      const hit = beatHit(audio.onset, audio.onsetStrength, e, r);
      horizon.step(audio.spectrum, audio.sampleRate, dt, r, profile);
      sun.step(audio.bassAtt, dt, r, e);
      diamond.step(audio.bassAtt * r * (0.3 + 0.7 * e), dt, P.motion);
      beam.step(audio.bass, audio.rms, dt, r, e);
      // Beat flares: the onset surge (as before) scaled by energy, and the energy-gated hit.
      const flare = surge.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing) * (0.25 + 0.75 * e);
      const beat = throb.step(hit, dt, ctx.reduceFlashing);
      const breathe = breath.step(audio.bpm, audio.beatPhase, e, dt, r);
      glow.step(audio.midAtt, Math.max(flare, beat), dt, r, e);
      flow.step(e, hit, dt, r, P.motion);
      tone.step(audio.centroid, e, dt, r, ctx.reduceFlashing);
      ripples.step(hit * (0.5 + 0.5 * P.motion), dt);
      const jolt = drop.step(hit, dt, P.motion);
      const spk = spike.step(hit, dt, ctx.reduceFlashing);
      mood.step(e, audio.bass, dt, r, P.motion);
      P.rise = mood.rise;
      layout(w, h, P, L);
      const sunR = L.sunR * sun.scale;
      const rangeDepth = L.rangeDepth * (1 + 0.32 * jolt + 0.1 * breathe);
      const beamB = P.beam * beam.bright * (1 + 0.5 * flare + 0.7 * beat + 0.2 * breathe);
      const beamW = L.beamWidth * beam.width * (1 + 0.9 * beat);
      const glowV = glow.value + 0.25 * breathe;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      const painted = isPainted(ctx.params.backdrop);

      // 1. The painted washes, at quarter resolution. (Resize first: it binds the target's texture
      // to the active unit, which must not then be the profile's while drawing into the target.)
      const tw = Math.max(1, Math.ceil(w / BG_DIV));
      const th = Math.max(1, Math.ceil(h / BG_DIV));
      if (painted && (bgTarget.width !== tw || bgTarget.height !== th)) bgTarget.resize(tw, th);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, profTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RED, gl.FLOAT, profile);
      if (painted) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bgTarget.fbo);
        gl.viewport(0, 0, tw, th);
        gl.useProgram(bgProg.program);
        gl.uniform2f(ub.u_res, w, h);
        gl.uniform2f(ub.u_scale, w / tw, h / th);
        gl.uniform1f(ub.u_unit, L.unit);
        gl.uniform1f(ub.u_horizon, L.horizon);
        gl.uniform1f(ub.u_time, flow.clock);
        gl.uniform1f(ub.u_turb, flow.turb);
        gl.uniform1f(ub.u_warm, tone.warm);
        gl.uniform1f(ub.u_bright, tone.bright);
        gl.uniform1f(ub.u_glow, glowV);
        gl.uniform3f(ub.u_sun, L.sunX, L.sunY, sunR);
        gl.uniform1f(ub.u_rays, mood.rays);
        gl.uniform1f(ub.u_refl, reflection(e, beam.level, r) * (1 + 0.3 * breathe));
        gl.uniform1f(ub.u_rangeHalf, L.rangeHalf);
        gl.uniform1f(ub.u_rangeDepth, rangeDepth);
        gl.uniform1f(ub.u_beamB, beamB);
        gl.uniform2fv(ub.u_rings, ripples.rings);
        gl.uniform1i(ub.u_prof, 0);
        gl.uniform1f(ub.u_n, N);
        gl.uniform3fv(ub.u_c, pal);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // 2. Everything else, over them.
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
      gl.uniform3f(u.u_sun, L.sunX, L.sunY, sunR);
      gl.uniform1f(u.u_rangeHalf, L.rangeHalf);
      gl.uniform1f(u.u_rangeDepth, rangeDepth);
      gl.uniform1f(u.u_beamW, beamW);
      gl.uniform1f(u.u_beamB, beamB);
      gl.uniform1f(u.u_rim, sun.rim);
      gl.uniform1f(u.u_reach, sun.reach);
      gl.uniform1f(u.u_diamond, diamond.angle);
      gl.uniform1f(u.u_corona, mood.corona);
      gl.uniform1f(u.u_glow, glowV);
      gl.uniform1f(u.u_spike, spk);
      gl.uniform1f(u.u_bloom, mood.bloom);
      gl.uniform1f(u.u_warm, tone.warm);
      gl.uniform2fv(u.u_rings, ripples.rings);
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
