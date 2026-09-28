// @ts-check
/**
 * Stargate — after the Star Gate sequence in *2001: A Space Odyssey*: you hurtle between two
 * infinite planes of streaming slit-scan light toward a glowing horizon, rolling about the
 * direction of travel.
 *
 * The waveform seeds the light. At a fixed rate (rows per second = rows ÷ travel time, faster on
 * bass surges) the newest waveform, trigger-aligned, is resampled into one row of a W × N RGBA
 * float history ring (signed wave, a peak-hold "streak", and the bands' hue and energy) with one
 * texSubImage2D. New rows enter at the horizon — the far glow is always the latest music — and
 * glide toward you as you travel. One full-screen pass ray-casts each pixel to the planes after
 * undoing the camera roll, so perspective stays exact while rolling.
 *
 * Pure logic lives in lib/ (slitscan, history, stargate-view, stargate-motion, palette) and is
 * tested there. Nothing is allocated per frame.
 */
import { createProgram } from "./lib/gl.js";
import { createSlitHistory } from "./lib/history.js";
import { paletteCoeffs } from "./lib/palette.js";
import { createRowBuilder } from "./lib/slitscan.js";
import {
  createIntensity,
  createRoll,
  createSolar,
  createSurge,
  effectiveMotion,
} from "./lib/stargate-motion.js";

/** Texels per history row (lateral resolution of the lanes). */
const W = 256;
/** Rows in the history ring per Detail option. */
const ROWS = { low: 128, medium: 256, high: 512 };
/** Seconds for a row to travel from the horizon to the eye at Speed 1. */
const TRAVEL = 3.2;
/** Depths (plane distance = 1) where rows enter and leave. */
const Z_FAR = 14;
const Z_NEAR = 0.24;
/** Texture widths per unit of lateral distance on the planes. */
const LANE = 0.32;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/stargate/";
  const [vs, fs] = await Promise.all([ctx.assets.text(dir + "fullscreen.vert"), ctx.assets.text(dir + "stargate.frag")]);
  const prog = createProgram(gl, vs, fs, dir + "stargate.frag");
  const u = prog.u;
  const vao = gl.createVertexArray();

  const tex = /** @type {WebGLTexture} */ (gl.createTexture());
  const builder = createRowBuilder(W);
  const history = createSlitHistory(W, rowCount(), (row, data) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, W, 1, gl.RGBA, gl.FLOAT, data);
  });
  allocHistory();

  const roll = createRoll();
  const surge = createSurge();
  const intensity = createIntensity();
  const solar = createSolar();
  const motion = { roll: 0, speed: 0 };
  const pal = new Float32Array(12);
  paletteCoeffs(ctx.params.palette, pal);

  /** The audio frame being drawn, for the row builder callback (set before each history step). */
  /** @type {import('../tidalviz').AudioFrame | null} */
  let audioNow = null;
  const build = (/** @type {Float32Array} */ row) => {
    const a = /** @type {import('../tidalviz').AudioFrame} */ (audioNow);
    builder.build(a.waveform, a.bands, row);
  };

  let hueNow = 0.5; // smoothed band hue and energy, for the horizon glow
  let energyNow = 0;
  let drift = 0; // palette cycling clock

  function rowCount() {
    const d = /** @type {keyof typeof ROWS} */ (String(ctx.params.detail));
    return ROWS[d] ?? ROWS.medium;
  }

  /** (Re)allocate the history texture at the ring's size; zero-filled, i.e. dark. */
  function allocHistory() {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, history.N, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  return {
    frame(audio, time) {
      const dt = time.dt;
      const { width: w, height: h } = ctx.size;
      effectiveMotion(Number(ctx.params.roll), Number(ctx.params.speed), ctx.reduceMotion, motion);
      const angle = roll.step(dt, motion.roll, audio.bassAtt);
      const surgeNow = surge.step(audio.bassAtt, dt);
      const pulse = intensity.step(audio.onset, audio.onsetStrength, audio.bassAtt, dt, ctx.reduceFlashing);
      const sol = solar.step(audio.onset, audio.onsetStrength, audio.bassAtt, dt, ctx.reduceFlashing);

      // Push the rows that fell due (bound texture = history; uploads happen in the callback).
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      audioNow = audio;
      history.step(dt, (history.N / TRAVEL) * Math.max(0, motion.speed) * surgeNow, build);
      audioNow = null;

      // Horizon glow follows the current music, smoothed (a thin band, not a full-frame change).
      let sum = 0;
      let moment = 0;
      const bands = audio.bands;
      for (let i = 0; i < bands.length; i++) {
        sum += bands[i];
        moment += bands[i] * i;
      }
      const k = 1 - Math.exp(-dt / 0.35);
      if (sum > 1e-6) hueNow += (moment / sum / (bands.length - 1) - hueNow) * k;
      energyNow += (sum / bands.length - energyNow) * k;
      drift += dt * 0.012;
      const gt = hueNow * 1.7 + drift;
      const glow = (0.3 + 1.4 * energyNow) * pulse;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog.program);
      gl.bindVertexArray(vao);
      gl.uniform1i(u.u_hist, 0);
      gl.uniform2f(u.u_res, w, h);
      gl.uniform1f(u.u_roll, angle);
      gl.uniform1f(u.u_spread, Number(ctx.params.spread));
      gl.uniform1f(u.u_head, history.head);
      gl.uniform1f(u.u_rows, history.N);
      gl.uniform1f(u.u_frac, history.frac);
      gl.uniform1f(u.u_zfar, Z_FAR);
      gl.uniform1f(u.u_znear, Z_NEAR);
      gl.uniform1f(u.u_lane, LANE);
      gl.uniform1f(u.u_texw, W);
      gl.uniform1f(u.u_smear, 1 + 3 * Number(ctx.params.streak) * surgeNow);
      gl.uniform1f(u.u_time, drift);
      gl.uniform1f(u.u_bright, Number(ctx.params.brightness) * pulse);
      gl.uniform1f(u.u_solar, sol);
      gl.uniform3f(
        u.u_glow,
        glow * (pal[0] + pal[3] * Math.cos(6.2831853 * (pal[6] * gt + pal[9]))),
        glow * (pal[1] + pal[4] * Math.cos(6.2831853 * (pal[7] * gt + pal[10]))),
        glow * (pal[2] + pal[5] * Math.cos(6.2831853 * (pal[8] * gt + pal[11]))),
      );
      gl.uniform3f(u.u_pa, pal[0], pal[1], pal[2]);
      gl.uniform3f(u.u_pb, pal[3], pal[4], pal[5]);
      gl.uniform3f(u.u_pc, pal[6], pal[7], pal[8]);
      gl.uniform3f(u.u_pd, pal[9], pal[10], pal[11]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    params(changed) {
      if ("palette" in changed) paletteCoeffs(ctx.params.palette, pal);
      if ("detail" in changed && history.resize(rowCount())) allocHistory();
    },

    dispose() {
      gl.deleteTexture(tex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
    },
  };
}
