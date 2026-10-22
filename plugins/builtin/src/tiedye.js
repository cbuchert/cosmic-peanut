// @ts-check
/**
 * Tie-Dye — dyed cotton that keeps changing with the music, for the `webgl2` renderer.
 *
 * A dye pass at half resolution (shaders/tiedye/tiedye.frag) paints the cloth: palette bands laid
 * out by the pattern (spiral, bullseye, crumple, shibori), ragged bleeding edges and uneven dye
 * from domain-warped noise, white crinkle lines from ridged noise, a cotton weave, and dye mixing
 * in absorbance so overlaps darken like real dye. A full-resolution composite (composite.frag)
 * upsamples it and adds the cotton weave.
 *
 * The music (all in lib/tiedye.js): the dye streams outward from the knot (createFlow) faster
 * when loud and in a surge on every beat, locked to the tempo when it is confident (onsets then
 * only accent, so a syncopated bass line doesn't pull the cloth off the beat). Each beat
 * lays a fresh band down at the knot (createRecord) whose color comes from the part of the
 * spectrum that stands out right then (createDominant), so the rings travelling outward record
 * the song. Pattern "auto" morphs between looks on phrase changes (createMorph) and the palette
 * drifts in hue (createPaletteDrift). Energy and tempo turn the cloth (createSpin), the spectrum
 * sets each band's width (createBandWidths), the waveform ripples the arms (createArmWarp,
 * warpAmount), mids and treble breathe the dye and its bleed (createBreath, createIntensity —
 * flash-limited, swelling on each beat), and onsets drop dye blooms (createBlooms). Everything
 * reaches the GPU as uniforms from preallocated arrays, so frame() allocates nothing.
 */
import { createProgram, createTarget } from "./lib/gl.js";
import {
  createArmWarp,
  createBandWidths,
  createBlooms,
  createBreath,
  createDominant,
  createFlow,
  createIntensity,
  createMorph,
  createPaletteDrift,
  createRecord,
  createSpin,
  driftPalette,
  edgesFromWidths,
  fabricIndex,
  isAutoPattern,
  loudness,
  MAX_COLORS,
  motionScale,
  paletteOf,
  patternIndex,
  warpAmount,
} from "./lib/tiedye.js";

/** How much the treble's breath loosens the band edges (added to the Bleed param). */
const BREATH_BLEED = 0.45;
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

  const base = new Float32Array(MAX_COLORS * 3);
  const colors = new Float32Array(MAX_COLORS * 3);
  const edges = new Float32Array(MAX_COLORS + 1);
  const widths = createBandWidths();
  const spin = createSpin();
  const flow = createFlow();
  const record = createRecord();
  const dominant = createDominant();
  const morph = createMorph();
  const drift = createPaletteDrift(0x7d1e);
  const breath = createBreath();
  const warp = createArmWarp();
  const blooms = createBlooms(0x7ed1e);
  const intensity = createIntensity();
  const spinIn = { twist: 0, speed: 0, motion: 1, bassAtt: 0, energy: 0, bpm: 0, reactivity: 0, reduceMotion: false };
  const flowIn = {
    rms: 0, bassAtt: 1, onset: false, onsetStrength: 0, bpm: 0, beatPhase: 0,
    reactivity: 1, motion: 1, speed: 1, reduceMotion: false,
  };
  const morphIn = { auto: true, home: 0, beat: false, tempo: false, energy: 0, reduceMotion: false };
  let nColors = paletteOf(ctx.params.palette, base);
  let clock = 0;

  return {
    frame(audio, time) {
      const dt = time.dt;
      const { width: w, height: h } = ctx.size;
      const react = Number(ctx.params.reactivity);
      const speed = Number(ctx.params.speed);
      const motion = Number(ctx.params.motion ?? 1);

      // While the source is silent the smoothed stats and the tempo can linger: ignore them.
      const live = !audio.silent;
      const bpm = live ? audio.bpm : 0;
      const bassAtt = live ? audio.bassAtt : 1;
      flowIn.rms = live ? audio.rms : 0;
      flowIn.bassAtt = bassAtt;
      flowIn.onset = live && audio.onset;
      flowIn.onsetStrength = audio.onsetStrength;
      flowIn.bpm = bpm;
      flowIn.beatPhase = audio.beatPhase;
      flowIn.reactivity = react;
      flowIn.motion = motion;
      flowIn.speed = speed;
      flowIn.reduceMotion = ctx.reduceMotion;
      const flowBefore = flow.flow;
      flow.step(dt, flowIn);

      // A beat lays down a band colored by the part of the spectrum that stands out right now;
      // louder music lays deeper dye.
      const lead = dominant.step(audio.bands, nColors, dt);
      record.step(flow.flow, flow.beat, lead, 0.8 + 0.35 * loudness(audio.rms));

      morphIn.auto = isAutoPattern(ctx.params.pattern);
      morphIn.home = patternIndex(ctx.params.pattern);
      morphIn.beat = flow.beat;
      morphIn.tempo = bpm > 0;
      morphIn.energy = flow.energy;
      morphIn.reduceMotion = ctx.reduceMotion;
      morph.step(dt, morphIn);
      driftPalette(base, nColors, drift.step(dt, morph.phrase), colors);

      spinIn.twist = Number(ctx.params.twist);
      spinIn.speed = speed;
      spinIn.motion = motion;
      spinIn.bassAtt = bassAtt;
      spinIn.energy = flow.energy;
      spinIn.bpm = bpm;
      spinIn.reactivity = react;
      spinIn.reduceMotion = ctx.reduceMotion;
      spin.step(dt, spinIn);
      edgesFromWidths(widths.step(audio.bands, nColors, dt, react), nColors, edges);
      const wave = warp.step(audio.waveform, dt);
      breath.step(dt, live ? audio.midAtt : 1, live ? audio.trebAtt : 1, react);
      blooms.step(ctx.params.bloom === true && flowIn.onset, audio.onsetStrength, dt, flow.flow - flowBefore);
      // The dye swells on the beat (a tempo beat at full strength); onsets only accent the flow and drop blooms.
      const strength = intensity.step(flow.beat, bpm > 0 ? 1 : audio.onsetStrength, dt, ctx.reduceFlashing, breath.dye);
      clock += dt * motionScale(spinIn);

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
      gl.uniform1i(u.u_pattern, morph.a);
      gl.uniform1i(u.u_patternB, morph.b);
      gl.uniform1f(u.u_mix, morph.mix);
      gl.uniform1f(u.u_arms, morph.armsA);
      gl.uniform1f(u.u_armsB, morph.armsB);
      gl.uniform1i(u.u_fabric, fabric);
      gl.uniform1f(u.u_twist, spin.twist);
      gl.uniform1f(u.u_turns, spin.turns);
      gl.uniform1f(u.u_flow, flow.flow);
      gl.uniform1f(u.u_time, clock);
      gl.uniform1i(u.u_n, nColors);
      gl.uniform1fv(u.u_edges, edges);
      gl.uniform3fv(u.u_col, colors);
      gl.uniform4fv(u.u_rec, record.data);
      gl.uniform1fv(u.u_warp, wave);
      gl.uniform1f(u.u_warpAmt, warpAmount(flow.energy, react));
      gl.uniform1f(u.u_bleed, Number(ctx.params.bleed) + BREATH_BLEED * breath.bleed);
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
      if ("palette" in changed) nColors = paletteOf(ctx.params.palette, base);
    },

    dispose() {
      dye.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      gl.deleteProgram(comp.program);
    },
  };
}
