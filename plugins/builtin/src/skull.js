// @ts-check
/**
 * Skull Trip — a glossy candy-apple red metal skull in a sea of psychedelic black-and-white op-art
 * stripes, both driven by the music.
 *
 * The stripes are the contour lines of a warped field (marble domain warp, a whirlpool, and the
 * skull's silhouette so they flow round it), anti-aliased with fwidth. The bass breathes their
 * frequency and fattens the black bands, beats launch ripples out from the skull, the waveform
 * bends them, and the flow follows the energy. The skull is a raymarched signed-distance model
 * (cranium, brow, cheekbones, sockets, nasal cavity, teeth, a hinged jaw) whose metal reflects the
 * stripes; its jaw chomps on kicks, it nods and tilts to the beat, sways with beatPhase, swells
 * with the bass, and whirlpools spin in its eyes with the treble.
 *
 * Two passes: the skull (inside its bounding circle only) into an offscreen layer, then the
 * full-resolution stripes with that layer composited over them.
 *
 * Photosensitivity: with reduceFlashing, the stripes' global motion runs on a phase-rate budget
 * (no pixel inverts more than 3 times a second, the field never flips at once) and every
 * whole-field change (thickness, ripple launches) goes through lib/flash.js. Pure logic lives in
 * lib/opart.js, lib/skull-motion.js and lib/skull-bounds.js and is tested there. Nothing is
 * allocated per frame.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import {
  createRipples,
  createRippleTrigger,
  createStripeDrive,
  createThickness,
  createWaveBend,
  lookColors,
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
  const head = "#version 300 es\nprecision highp float;\n" + glslDefines() + opart + "\n";
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
  const look = { acid: false, paperAlpha: 1 };
  const colors = new Float32Array(6);
  const rot = new Float32Array(9);
  const knobs = { reactivity: 1, warp: 1, speed: 1, jaw: 1 };
  const eff = { speed: 1, warp: 1, nod: 1, ripple: 1, jaw: 1, reactivity: 1 };
  const motionDrive = { jaw: 1, reactivity: 1, nod: 1 };
  const stripeIn = { density: 1, speed: 1, warp: 1, reactivity: 1, bass: 1, bassAtt: 1, energy: 1 };
  let energy = 1;
  let clock = 0;
  resolveLook(ctx.params.mode, ctx.params.stripes, look);

  /**
   * Uniforms both passes share (the stripe field).
   * @param {Record<string, WebGLUniformLocation | null>} u
   * @param {number} w @param {number} h
   * @param {number} outlineScale
   */
  function shared(u, w, h, outlineScale) {
    const short = Math.min(w, h);
    gl.uniform2f(u.u_view, w / short, h / short);
    gl.uniform1f(u.u_freq, drive.freq);
    gl.uniform1f(u.u_phase, drive.phase % TAU);
    gl.uniform1f(u.u_flow, drive.flow);
    gl.uniform1f(u.u_warp, eff.warp);
    gl.uniform1f(u.u_duty, drive.duty);
    gl.uniform4f(u.u_outline, outlineScale, motion.roll, 0.55 * Math.sin(motion.jaw), 0);
    gl.uniform2fv(u.u_ripples, ripples.data);
    gl.uniform1fv(u.u_wave, waveNow);
    gl.uniform3f(u.u_ink, colors[0], colors[1], colors[2]);
    gl.uniform3f(u.u_paper, colors[3], colors[4], colors[5]);
    gl.uniform1f(u.u_paperAlpha, look.paperAlpha);
  }
  /**
   * The slew-limited waveform of the current frame (bend's own buffer).
   * @type {Float32Array}
   */
  let waveNow = new Float32Array(WAVE_POINTS);

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

      energy += ((audio.bassAtt + audio.midAtt + audio.trebAtt) / 3 - energy) * (1 - Math.exp(-dt / 0.5));
      stripeIn.density = Number(p.density);
      stripeIn.speed = eff.speed;
      stripeIn.warp = eff.warp;
      stripeIn.reactivity = eff.reactivity;
      stripeIn.bass = audio.bass;
      stripeIn.bassAtt = audio.bassAtt;
      stripeIn.energy = energy;
      drive.step(dt, stripeIn, ctx.reduceFlashing);
      drive.duty = thickness.step(audio.bass, eff.reactivity, dt, ctx.reduceFlashing);
      const launch = trigger.step(audio.onset, audio.onsetStrength, eff.reactivity * eff.ripple, dt, ctx.reduceFlashing);
      if (launch > 0) ripples.spawn(launch);
      ripples.step(dt);
      waveNow = bend.step(audio.waveform, dt);
      const spin = eyes.step(audio.trebAtt, eff.reactivity, dt) % TAU;
      lookColors(look.acid, clock, colors);

      // Object-from-world rotation = transpose of Ry(yaw)·Rx(pitch)·Rz(roll); a column-major
      // upload of the row-major world-from-object matrix is exactly that transpose.
      worldFromObject(motion.yaw, motion.pitch, motion.roll, rot);
      const size = Number(p.size) || 1;
      const focal = FOCAL * size;
      const circle = screenRadius(motion.scale, focal);
      const outlineScale = (focal / CAM_DIST) * motion.scale;

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
      shared(u, w, h, outlineScale);
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
      shared(u, w, h, outlineScale);
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
