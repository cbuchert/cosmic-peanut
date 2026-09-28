// @ts-check
/**
 * Radar — a PPI (plan position indicator) scope whose sweep draws a spectrogram.
 *
 * The sweep arm turns at `speed`, or locked to the tempo (one rotation per bar or per beat, phase-
 * aligned to beatPhase). Each bearing is one time slice: as the arm passes it, it writes the
 * current spectrum along that radius — frequency on a log scale, lowest at the center, `maxFreq`
 * at the rim, magnitude in dB above a `floor` with a slow auto-gain — into a polar phosphor
 * buffer that decays over about one rotation. Sustained tones trace concentric arcs, a melody
 * steps between radii, drum hits leave radial spokes, and silence is black. It is fully deterministic.
 *
 * GPU: the phosphor is a fixed 2048 × 512 (bearing × radius) half-float ping-pong, independent of
 * the canvas size; each frame one pass decays it and repaints the wedge swept since the last frame
 * (blending last frame's spectrum into this one's across the wedge), and one full-screen pass draws
 * the scope (phosphor + glow, arm, graticule) analytically. Pure logic is in lib/radar.js and
 * tested there. Nothing is allocated per frame.
 */
import { createFlashLimiter } from "./lib/flash.js";
import { createProgram, createTarget } from "./lib/gl.js";
import {
  createDecay,
  createLevel,
  createSweep,
  fitScope,
  phosphorPalette,
  spectrumColumn,
  sweptWedge,
} from "./lib/radar.js";

/** Phosphor texels around the scope (bearing) and along a radius. */
const N_ANG = 2048;
const N_RAD = 512;

/** `maxFreq` param → Hz. @param {unknown} v */
const maxHzOf = (v) => (v === "4k" ? 4000 : v === "8k" ? 8000 : 16000);

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

  // Spectrogram columns (one value per radial texel): row 0 last frame's, row 1 this frame's.
  const columnTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, columnTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, N_RAD, 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const raw = new Float32Array(N_RAD);
  const last = new Float32Array(N_RAD);
  const column = new Float32Array(N_RAD);

  const sweep = createSweep();
  const decay = createDecay();
  const level = createLevel();
  const wedge = new Float32Array(2);
  const scope = { cx: 0, cy: 0, radius: 0 };
  const pal = new Float32Array(6);
  const sweepIn = { sync: "bar", speed: 0.25, bpm: 0, beatPhase: 0, reduceMotion: false };
  const flash = createFlashLimiter();
  let kick = 0;

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

      const sr = audio.sampleRate > 0 ? audio.sampleRate : 48000;
      spectrumColumn(audio.spectrum, sr, Math.min(maxHzOf(p.maxFreq), sr / 2), raw);
      last.set(column);
      level.step(raw, time.dt, Number(p.floor), Number(p.gain), column);

      // A gentle whole-scope lift on onsets; full-frame, so it goes through the flash limiter.
      kick = audio.onset ? Math.min(1, 0.4 + audio.onsetStrength) : kick * Math.exp(-time.dt * 5);
      const pulse = flash.step(kick, time.dt, ctx.reduceFlashing);

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, columnTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N_RAD, 1, gl.RED, gl.FLOAT, last);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, N_RAD, 1, gl.RED, gl.FLOAT, column);

      // 1. Decay the phosphor and paint this frame's spectrogram slice into the swept wedge.
      const src = targets[cur];
      const dst = targets[cur ^ 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, N_ANG, N_RAD);
      gl.useProgram(paint.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(paint.u.u_prev, 0);
      gl.uniform1i(paint.u.u_column, 1);
      gl.uniform1f(paint.u.u_decay, decay.step(time.dt, sweep.rate, Number(p.persistence)));
      gl.uniform1f(paint.u.u_start, wedge[0]);
      gl.uniform1f(paint.u.u_span, wedge[1]);
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
      gl.deleteTexture(columnTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(paint.program);
      gl.deleteProgram(comp.program);
    },
  };
}
