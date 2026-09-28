// @ts-check
/**
 * Radar — a PPI (plan position indicator) scope painted by the music.
 *
 * The sweep arm turns at `speed`, or locked to the tempo (one rotation per bar or per beat, phase-
 * aligned to beatPhase). As it passes each bearing it writes the current spectrum along that
 * radius — bass at the center, highs at the rim — into a polar phosphor buffer that decays over
 * about one rotation, so the screen always holds a glowing polar spectrogram of the last rotation of
 * sound. Transients leave bright contacts at the bearing where the sweep was and the radius of the
 * band that fired; they flare each time the sweep passes and fade over a few rotations. The
 * waveform speckles ground clutter near the center.
 *
 * GPU: the phosphor is a fixed 2048 × 256 (bearing × radius) float ping-pong, independent of the
 * canvas size; each frame one pass decays it and repaints the wedge swept since the last frame, and
 * one full-screen pass draws the scope (phosphor + glow, contacts, arm, graticule) analytically.
 * Pure logic is in lib/radar.js and tested there. Nothing is allocated per frame.
 */
import { createFlashLimiter } from "./lib/flash.js";
import { createProgram, createTarget } from "./lib/gl.js";
import {
  bandProfile,
  clutterProfile,
  createContacts,
  createDecay,
  createSweep,
  fitScope,
  phosphorPalette,
  sweptWedge,
} from "./lib/radar.js";

/** Phosphor texels around the scope (bearing) and along a radius. */
const N_ANG = 2048;
const N_RAD = 256;
const MAX_CONTACTS = 32;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/radar/";
  const [vs, paintFs, compFs] = await Promise.all(
    ["fullscreen.vert", "paint.frag", "composite.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const paint = createProgram(gl, vs, paintFs, dir + "paint.frag");
  const comp = createProgram(gl, vs, compFs, dir + "composite.frag");
  const vao = gl.createVertexArray();

  // Phosphor ping-pong; bearing wraps around, radius clamps.
  const targets = [createTarget(gl), createTarget(gl)];
  for (const t of targets) {
    t.resize(N_ANG, N_RAD);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  }
  let cur = 0;

  // This frame's radial profile: row 0 the spectrum, row 1 the clutter amplitude.
  const profileTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, profileTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, N_RAD, 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const spectrum = new Float32Array(N_RAD);
  const clutter = new Float32Array(N_RAD);

  const sweep = createSweep();
  const decay = createDecay();
  const contacts = createContacts(MAX_CONTACTS);
  const packed = new Float32Array(4 * MAX_CONTACTS);
  const wedge = new Float32Array(2);
  const scope = { cx: 0, cy: 0, radius: 0 };
  const pal = new Float32Array(6);
  const sweepIn = { sync: "bar", speed: 0.25, bpm: 0, beatPhase: 0, reduceMotion: false };
  const flash = createFlashLimiter();
  let kick = 0;
  let seed = 0;

  phosphorPalette(ctx.params.palette, pal);

  return {
    frame(audio, time) {
      const p = ctx.params;
      sweepIn.sync = String(p.sync);
      sweepIn.speed = Number(p.speed);
      sweepIn.bpm = audio.bpm;
      sweepIn.beatPhase = audio.beatPhase;
      sweepIn.reduceMotion = ctx.reduceMotion;
      const prev = sweep.turns;
      const now = sweep.step(time.dt, sweepIn);
      sweptWedge(prev, now, wedge);

      bandProfile(audio.bands, Number(p.gain), spectrum);
      clutterProfile(audio.waveform, clutter);
      contacts.step(prev, now, audio.onset, audio.onsetStrength, audio.bands);
      const count = p.contacts ? contacts.pack(packed, now) : 0;

      // A gentle whole-scope lift on onsets; full-frame, so it goes through the flash limiter.
      kick = audio.onset ? Math.min(1, 0.4 + audio.onsetStrength) : kick * Math.exp(-time.dt * 5);
      const pulse = flash.step(kick, time.dt, ctx.reduceFlashing);
      seed = (seed + 1) % 4096;

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, profileTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N_RAD, 1, gl.RED, gl.FLOAT, spectrum);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, N_RAD, 1, gl.RED, gl.FLOAT, clutter);

      // 1. Decay the phosphor and repaint the swept wedge.
      const src = targets[cur];
      const dst = targets[cur ^ 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, N_ANG, N_RAD);
      gl.useProgram(paint.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(paint.u.u_prev, 0);
      gl.uniform1i(paint.u.u_profile, 1);
      gl.uniform1f(paint.u.u_decay, decay.step(time.dt, sweep.rate, Number(p.persistence)));
      gl.uniform1f(paint.u.u_start, wedge[0]);
      gl.uniform1f(paint.u.u_span, wedge[1]);
      gl.uniform1f(paint.u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. The scope, to the transparent premultiplied canvas.
      const { width: w, height: h } = ctx.size;
      fitScope(w, h, scope);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(comp.program);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(comp.u.u_phos, 0);
      gl.uniform2f(comp.u.u_center, scope.cx, scope.cy);
      gl.uniform1f(comp.u.u_radius, scope.radius);
      gl.uniform1f(comp.u.u_turn, now - Math.floor(now));
      gl.uniform3f(comp.u.u_col, pal[0], pal[1], pal[2]);
      gl.uniform3f(comp.u.u_hot, pal[3], pal[4], pal[5]);
      gl.uniform1f(comp.u.u_grat, Number(p.graticule));
      gl.uniform1f(comp.u.u_gain, 1 + 0.2 * pulse);
      gl.uniform4fv(comp.u.u_contacts, packed);
      gl.uniform1i(comp.u.u_count, count);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      cur ^= 1;
    },

    // The phosphor is polar and canvas-independent; the scope is re-fitted every frame.
    resize() {},

    params(changed) {
      if ("palette" in changed) phosphorPalette(ctx.params.palette, pal);
    },

    dispose() {
      for (const t of targets) t.dispose();
      gl.deleteTexture(profileTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(paint.program);
      gl.deleteProgram(comp.program);
    },
  };
}
