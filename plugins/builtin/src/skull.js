// @ts-check
/**
 * Skull Trip — a glossy candy-apple red metal skull in a sea of psychedelic black-and-white op-art
 * stripes, both driven by the music.
 *
 * The stripes are the contour lines of a distance field: the skull's silhouette smooth-min'd with
 * loop emitters, marble-warped and twisted into a whirlpool, anti-aliased with fwidth. Its phase
 * grows, so closed loops are born behind the skull and at each emitter and grow off the screen:
 * slowly in silence, faster with the music's energy, in surges on the beats. Strong beats seed new
 * emitters at the angle of the loudest part of the spectrum, launch ripples that rise from under
 * the skull and run across the screen; the spectrum bulges the stripes outward by angle (bass
 * under the jaw, highs over the cranium), the waveform bends them, the whirlpool tightens with the
 * energy and reverses with the phrase, and the bass swells the black bands. The skull is a
 * raymarched signed-distance model (cranium, brow, cheekbones, sockets, nasal cavity, teeth, a
 * hinged jaw) whose metal reflects the stripes; its jaw chomps on kicks, it nods and tilts to the beat, sways with beatPhase, swells
 * with the bass, and whirlpools spin in its eyes with the treble.
 *
 * Two passes: the skull (inside its bounding circle only) into an offscreen layer, then the
 * full-resolution stripes with that layer composited over them.
 *
 * Photosensitivity: with reduceFlashing, every stripe motion runs on one per-pixel phase-rate
 * budget (lib/opart.js RATE_BUDGET: no pixel alternates black/white faster than 3 Hz): the drive
 * gets what the local effects (ripples, bulge, emitters, wave, thickness) don't reserve, and every
 * whole-field change (thickness, ripple launches) also goes through lib/flash.js. Pure logic lives
 * in lib/opart.js, lib/skull-motion.js and lib/skull-bounds.js and is tested there. Nothing is
 * allocated per frame.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import {
  createBulge,
  createEmitters,
  createEnergy,
  createPhrase,
  createRipples,
  createRippleTrigger,
  createStripeDrive,
  createThickness,
  createWaveBend,
  emitterSpot,
  lookColors,
  opartDefines,
  resolveLook,
} from "./lib/opart.js";
import { CAM_DIST, glslDefines, screenRadius } from "./lib/skull-bounds.js";
import { createEyeSpin, createSkullMotion, effectiveDrive, worldFromObject } from "./lib/skull-motion.js";

/** Focal length (screen units) at Skull size 1: the skull fills about 60% of the window height. */
const FOCAL = 3.3;
/** Skull layer resolution, as a fraction of the canvas (the raymarch is the costly part). */
const SKULL_RES = 0.5;
const RIPPLES = 8;
const WAVE_POINTS = 32;
const EMITTERS = 6;
const SECTORS = 16;
/** Seconds between new emitters at least (×3 under Reduce motion). */
const EMIT_GAP = 1.2;
const TAU = Math.PI * 2;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/skull/";
  const [vs, opart, skullSrc, compSrc] = await Promise.all([
    ctx.assets.text(dir + "fullscreen.vert"),
    ctx.assets.text(dir + "opart.glsl"),
    ctx.assets.text(dir + "skull.frag"),
    ctx.assets.text(dir + "composite.frag"),
  ]);
  const sizes = { ripples: RIPPLES, wave: WAVE_POINTS, emitters: EMITTERS, sectors: SECTORS };
  const head = "#version 300 es\nprecision highp float;\n" + glslDefines() + opartDefines(sizes) + opart + "\n";
  const skullProg = createProgram(gl, vs, head + skullSrc, dir + "skull.frag");
  const compProg = createProgram(gl, vs, head + compSrc, dir + "composite.frag");
  const vao = gl.createVertexArray();
  const layer = createTarget(gl);

  const motion = createSkullMotion();
  const eyes = createEyeSpin();
  const drive = createStripeDrive();
  const thickness = createThickness();
  const trigger = createRippleTrigger();
  const ripples = createRipples(RIPPLES);
  const bend = createWaveBend(WAVE_POINTS);
  const energy = createEnergy();
  const phrase = createPhrase();
  const bulge = createBulge(SECTORS);
  const emitters = createEmitters(EMITTERS);
  const spot = new Float32Array(2);
  const outline = [1, 0, 0];
  let sinceEmit = Infinity;
  let emitSeq = 0;
  const look = { acid: false, paperAlpha: 1 };
  const colors = new Float32Array(6);
  const rot = new Float32Array(9);
  const knobs = { reactivity: 1, warp: 1, speed: 1, jaw: 1 };
  const eff = { speed: 1, warp: 1, nod: 1, ripple: 1, jaw: 1, reactivity: 1 };
  const motionDrive = { jaw: 1, reactivity: 1, nod: 1 };
  const stripeIn = { density: 1, speed: 1, warp: 1, reactivity: 1, bassAtt: 1, energy: 0, surge: 0, dir: 1 };
  let clock = 0;
  resolveLook(ctx.params.mode, ctx.params.stripes, look);

  /**
   * Uniforms both passes share (the stripe field).
   * @param {Record<string, WebGLUniformLocation | null>} u
   * @param {number} w @param {number} h
   */
  function shared(u, w, h) {
    const short = Math.min(w, h);
    gl.uniform2f(u.u_view, w / short, h / short);
    gl.uniform1f(u.u_freq, drive.freq);
    gl.uniform1f(u.u_phase, drive.phase % TAU);
    gl.uniform1f(u.u_flow, drive.flow);
    gl.uniform1f(u.u_warp, eff.warp);
    gl.uniform1f(u.u_duty, drive.duty);
    gl.uniform1f(u.u_twist, drive.twist);
    gl.uniform4f(u.u_outline, outline[0], outline[1], outline[2], 0);
    gl.uniform2fv(u.u_ripples, ripples.data);
    gl.uniform1fv(u.u_wave, waveNow);
    gl.uniform4fv(u.u_emitters, emitters.data);
    gl.uniform1fv(u.u_bulge, bulgeNow);
    gl.uniform3f(u.u_ink, colors[0], colors[1], colors[2]);
    gl.uniform3f(u.u_paper, colors[3], colors[4], colors[5]);
    gl.uniform1f(u.u_paperAlpha, look.paperAlpha);
  }
  /**
   * The slew-limited waveform of the current frame (bend's own buffer).
   * @type {Float32Array}
   */
  let waveNow = new Float32Array(WAVE_POINTS);
  /** @type {Float32Array} */
  let bulgeNow = new Float32Array(SECTORS);

  return {
    frame(audio, time) {
      const dt = time.dt;
      const p = ctx.params;
      const { width: w, height: h } = ctx.size;
      clock += dt;

      knobs.reactivity = Number(p.reactivity);
      knobs.warp = Number(p.warp);
      knobs.speed = Number(p.speed);
      knobs.jaw = Number(p.jaw);
      effectiveDrive(knobs, ctx.reduceMotion, eff);
      motionDrive.jaw = eff.jaw;
      motionDrive.reactivity = eff.reactivity;
      motionDrive.nod = eff.nod;
      motion.step(audio, dt, motionDrive);

      energy.step(audio, dt);
      const dir = phrase.step(audio.bpm, audio.beatPhase, energy.level, dt);
      stripeIn.density = Number(p.density);
      stripeIn.speed = eff.speed;
      stripeIn.warp = eff.warp;
      stripeIn.reactivity = eff.reactivity;
      stripeIn.bassAtt = audio.bassAtt;
      stripeIn.energy = energy.level;
      stripeIn.surge = energy.surge * eff.ripple;
      stripeIn.dir = dir;
      drive.step(dt, stripeIn, ctx.reduceFlashing);
      drive.duty = thickness.step(audio.bass, eff.reactivity, dt, ctx.reduceFlashing);
      const launch = trigger.step(audio.onset, audio.onsetStrength, eff.reactivity * eff.ripple, dt, ctx.reduceFlashing);
      if (launch > 0) ripples.spawn(launch);
      ripples.step(dt);
      waveNow = bend.step(audio.waveform, dt);
      bulgeNow = bulge.step(audio.bands, eff.reactivity * eff.ripple, dt);

      const size = Number(p.size) || 1;
      const focal = FOCAL * size;
      outline[0] = (focal / CAM_DIST) * motion.scale;
      outline[1] = motion.roll;
      outline[2] = 0.55 * Math.sin(motion.jaw);
      // Strong beats seed a loop emitter where the spectrum is loudest, alternating sides.
      sinceEmit += dt;
      if (launch > 0.5 && sinceEmit >= EMIT_GAP * (eff.ripple < 1 ? 3 : 1)) {
        let best = 0;
        for (let i = 1; i < SECTORS; i++) if (bulgeNow[i] > bulgeNow[best]) best = i;
        if (bulgeNow[best] === 0) best = (emitSeq * 7) % SECTORS;
        emitterSpot(best, SECTORS, emitSeq % 2 ? -1 : 1, emitSeq, outline, spot);
        if (emitters.spawn(spot[0], spot[1], outline)) {
          emitSeq++;
          sinceEmit = 0;
        }
      }
      emitters.step(dt, drive.freq, outline, ctx.reduceFlashing);
      const spin = eyes.step(audio.trebAtt, eff.reactivity, dt) % TAU;
      lookColors(look.acid, clock, colors);

      // Object-from-world rotation = transpose of Ry(yaw)·Rx(pitch)·Rz(roll); a column-major
      // upload of the row-major world-from-object matrix is exactly that transpose.
      worldFromObject(motion.yaw, motion.pitch, motion.roll, rot);
      const circle = screenRadius(motion.scale, focal);

      // Skull layer.
      const sw = Math.max(1, Math.round(w * SKULL_RES));
      const sh = Math.max(1, Math.round(h * SKULL_RES));
      if (layer.width !== sw || layer.height !== sh) layer.resize(sw, sh);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(skullProg.program);
      let u = skullProg.u;
      shared(u, w, h);
      gl.uniformMatrix3fv(u.u_rot, false, rot);
      gl.uniform1f(u.u_scale, motion.scale);
      gl.uniform1f(u.u_focal, focal);
      gl.uniform1f(u.u_camDist, CAM_DIST);
      gl.uniform1f(u.u_circle, circle);
      gl.uniform1f(u.u_jaw, motion.jaw);
      gl.uniform1f(u.u_eyeSpin, spin);
      gl.uniform1f(u.u_pixel, 2 / Math.min(sw, sh));
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Stripes + composite, full resolution.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(compProg.program);
      u = compProg.u;
      shared(u, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.tex);
      gl.uniform1i(u.u_skull, 0);
      gl.uniform1f(u.u_circle, circle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    params(changed) {
      if ("mode" in changed || "stripes" in changed) resolveLook(ctx.params.mode, ctx.params.stripes, look);
    },

    dispose() {
      layer.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(skullProg.program);
      gl.deleteProgram(compProg.program);
    },
  };
}
