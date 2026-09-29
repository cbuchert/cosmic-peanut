// @ts-check
/**
 * Tie-Dye — dyed cotton that breathes with the music, for the `webgl2` renderer.
 *
 * A dye pass at half resolution (shaders/tiedye/tiedye.frag) paints the cloth: palette bands laid
 * out by the pattern (spiral, bullseye, crumple, shibori), ragged bleeding edges and uneven dye
 * from domain-warped noise, white crinkle lines from ridged noise, a cotton weave, and dye mixing
 * in absorbance so overlaps darken like real dye. A full-resolution composite (composite.frag)
 * upsamples it and adds the cotton weave.
 *
 * The music: bass tightens the twist and turns the spiral (lib/tiedye createSpin); each band's
 * width follows the energy in its region of the spectrum (createBandWidths); the waveform wobbles
 * the arms (createArmWarp); onsets drop dye blooms from a seeded pool (createBlooms); beats swell
 * the dye strength through the flash limiter (createIntensity). Everything reaches the GPU as
 * uniforms from preallocated arrays, so frame() allocates nothing.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import {
  createArmWarp,
  createBandWidths,
  createBlooms,
  createIntensity,
  createSpin,
  edgesFromWidths,
  fabricIndex,
  MAX_COLORS,
  paletteOf,
  patternIndex,
} from "./lib/tiedye.js";

/** How far (turns) the waveform may push the arms at Reactivity 1. */
const WARP_GAIN = 1;
/**
 * Resolution of the dye pass relative to the canvas. Everything in it is soft (bleeding edges,
 * feathered crinkles), so a quarter of the pixels looks the same once the full-resolution
 * composite adds the weave, and costs about a quarter of the GPU time.
 */
const DYE_SCALE = 0.5;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/tiedye/";
  const [vs, fs, cfs] = await Promise.all(
    ["fullscreen.vert", "tiedye.frag", "composite.frag"].map((f) => ctx.assets.text(dir + f)),
  );
  const prog = createProgram(gl, vs, fs, dir + "tiedye.frag");
  const comp = createProgram(gl, vs, cfs, dir + "composite.frag");
  const u = prog.u;
  const vao = gl.createVertexArray();
  const dye = createTarget(gl);

  function resize() {
    dye.resize(Math.max(1, Math.round(ctx.size.width * DYE_SCALE)), Math.max(1, Math.round(ctx.size.height * DYE_SCALE)));
  }
  resize();

  const colors = new Float32Array(MAX_COLORS * 3);
  const edges = new Float32Array(MAX_COLORS + 1);
  const widths = createBandWidths();
  const spin = createSpin();
  const warp = createArmWarp();
  const blooms = createBlooms(0x7ed1e);
  const intensity = createIntensity();
  const spinIn = { twist: 0, speed: 0, bassAtt: 0, reactivity: 0, reduceMotion: false };
  let nColors = paletteOf(ctx.params.palette, colors);
  let clock = 0;

  return {
    frame(audio, time) {
      const dt = time.dt;
      const { width: w, height: h } = ctx.size;
      const react = Number(ctx.params.reactivity);
      const speed = Number(ctx.params.speed);

      spinIn.twist = Number(ctx.params.twist);
      spinIn.speed = speed;
      spinIn.bassAtt = audio.bassAtt;
      spinIn.reactivity = react;
      spinIn.reduceMotion = ctx.reduceMotion;
      spin.step(dt, spinIn);
      edgesFromWidths(widths.step(audio.bands, nColors, dt, react), nColors, edges);
      const wave = warp.step(audio.waveform, dt);
      blooms.step(ctx.params.bloom === true && audio.onset, audio.onsetStrength, dt);
      const strength = intensity.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing);
      clock += dt * speed;

      const fabric = fabricIndex(ctx.params.fabric);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // 1. Dye at reduced resolution (linear, premultiplied).
      gl.bindFramebuffer(gl.FRAMEBUFFER, dye.fbo);
      gl.viewport(0, 0, dye.width, dye.height);
      gl.useProgram(prog.program);
      gl.uniform2f(u.u_res, dye.width, dye.height);
      gl.uniform1f(u.u_px, 0.5 * Math.min(dye.width, dye.height));
      gl.uniform1i(u.u_pattern, patternIndex(ctx.params.pattern));
      gl.uniform1i(u.u_fabric, fabric);
      gl.uniform1f(u.u_twist, spin.twist);
      gl.uniform1f(u.u_turns, spin.turns);
      gl.uniform1f(u.u_time, clock);
      gl.uniform1i(u.u_n, nColors);
      gl.uniform1fv(u.u_edges, edges);
      gl.uniform3fv(u.u_col, colors);
      gl.uniform1fv(u.u_warp, wave);
      gl.uniform1f(u.u_warpAmt, WARP_GAIN * Math.min(2, react));
      gl.uniform1f(u.u_bleed, Number(ctx.params.bleed));
      gl.uniform1f(u.u_intensity, strength);
      gl.uniform4fv(u.u_bloom, blooms.data);
      gl.uniform1fv(u.u_bloomCol, blooms.color);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. Weave into cotton at full resolution, onto the transparent canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(comp.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dye.tex);
      gl.uniform1i(comp.u.u_dye, 0);
      gl.uniform1i(comp.u.u_fabric, fabric);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    resize,

    params(changed) {
      if ("palette" in changed) nColors = paletteOf(ctx.params.palette, colors);
    },

    dispose() {
      dye.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(comp.program);
    },
  };
}
