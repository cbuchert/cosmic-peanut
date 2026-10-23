// @ts-check
/**
 * Tiled Torus — the interlocking tiling wrapped around a torus, printed like a multi-block
 * woodcut, for the `webgl2` renderer. Seen from outside (the torus tumbles slowly over paper) or
 * from inside the tube (the camera flies along the ring, the tiled walls wrapping round it, fog
 * down the tube); Auto dives in on a phrase change and back out on a later one.
 *
 * A torus is doubly periodic, so the plane tiling wraps it exactly: conformal coordinates of the
 * torus (θ around the ring, t(φ) around the tube) are scaled by lattice counts that are periods
 * of the warped, coloured tiling (lib/torus.js), so tiles are square and the tiling closes both
 * ways. The engine (lib/tess-gl.js, shaders/tess/tess.glsl) and the music (lib/tess-music.js)
 * are Metamorphosis's; this surface is shaders/tess/torus.frag. Glide travel (bass and an eased
 * beat surge) drives the orbit, the fly speed and the tiles' flow along the tube; the
 * figure/ground front travels around the ring from the camera. The waveform deforms the surface
 * (lib/torus-wave.js): each ring born at the hole rolls a full lap round the tube, stamped by the
 * beat it was laid down on. frame() allocates nothing.
 */
import { createProgram } from "./lib/gl.js";
import { createTessPipeline } from "./lib/tess-gl.js";
import { createTessState, renderScale } from "./lib/tess-music.js";
import { createTorusCamera, latticeCounts, mapParams } from "./lib/torus.js";
import { BIRTH, COLS, createWaveHistory, LAP_ROWS, liveDisp, ROWS, stepFactor, waveAmp } from "./lib/torus-wave.js";

/** March steps per Quality (low, medium, high): the displaced shell takes short steps. */
const STEPS = { low: 96, medium: 128, high: 160 };
/** Texture units of the wave history and the displacement map (the pipeline's passes use 0). */
const WAVE_UNIT = 1;
const MAP_UNIT = 2;
/** Displacement map size: θ across (4 per history column), age up. */
const MAP_W = 512;
const MAP_H = 256;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const tess = await createTessPipeline(ctx, "shaders/tess/torus.frag");
  const state = createTessState();
  const cam = createTorusCamera();
  const counts = { nu: 0, nv: 0, lx: 0, ly: 0 };
  const p = {
    view: "auto",
    symmetry: "p4",
    thickness: 0.36,
    palette: "",
    reactivity: 1,
    speed: 1,
    morph: 0.7,
    ink: 1,
    hatching: 0.6,
    wave: 0.7,
    travel: 4,
    detail: 0.15,
    height: 1,
    reduceMotion: false,
    reduceFlashing: false,
  };
  const camIn = { view: "auto", thickness: 0.36, stepped: false, reduceMotion: false };
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const waveTex = /** @type {WebGLTexture} */ (gl.createTexture());
  const bindWave = () => {
    gl.activeTexture(gl.TEXTURE0 + WAVE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, waveTex);
  };
  const history = createWaveHistory(COLS, ROWS, (row, data) => {
    bindWave();
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, COLS, 1, gl.RED, gl.FLOAT, data);
    gl.activeTexture(gl.TEXTURE0);
  });
  /** @param {number} unit @param {WebGLTexture} tex @param {number} w @param {number} h @param {Float32Array | null} data */
  const floatTex = (unit, tex, w, h, data) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
  };
  floatTex(WAVE_UNIT, waveTex, COLS, ROWS, history.data);
  // The displacement map: rendered once a frame (shaders/tess/torus-disp.frag) so the march reads
  // one bilinear tap per step. Needs float colour buffers; without them the torus stays smooth.
  const canMap = Boolean(gl.getExtension("EXT_color_buffer_float"));
  const mapTex = /** @type {WebGLTexture} */ (gl.createTexture());
  const mapFbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
  floatTex(MAP_UNIT, mapTex, MAP_W, MAP_H, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const [vsSrc, dispSrc] = await Promise.all(["shaders/tess/fullscreen.vert", "shaders/tess/torus-disp.frag"].map((f) => ctx.assets.text(f)));
  const dispProg = createProgram(gl, vsSrc, dispSrc, "shaders/tess/torus-disp.frag");
  const dispVao = gl.createVertexArray();
  const renderMap = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo);
    gl.viewport(0, 0, MAP_W, MAP_H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(dispProg.program);
    gl.bindVertexArray(dispVao);
    bindWave();
    gl.activeTexture(gl.TEXTURE0);
    const u = dispProg.u;
    gl.uniform1i(u.u_wave, WAVE_UNIT);
    gl.uniform3f(u.u_wHist, history.head, ROWS, history.frac);
    gl.uniform2f(u.u_wLap, LAP_ROWS, BIRTH);
    gl.uniform2f(u.u_size, MAP_W, MAP_H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  const waveIn = { travel: 4, detail: 0.15, env: 0, bassAtt: 1, reactivity: 1 };
  let amp = 0;
  let dmax = 0;
  let stepK = 1;
  let steps = STEPS.high;

  const setQuality = () => {
    const q = String(ctx.params.quality);
    steps = q === "low" ? STEPS.low : q === "medium" ? STEPS.medium : STEPS.high;
    tess.resize(renderScale(q));
  };
  setQuality();

  /** @type {import('./lib/tess-gl.js').SetSurface} */
  const surface = (gl, u) => {
    const c = cam.pose;
    gl.uniform2f(u.u_lxy, counts.lx, counts.ly);
    gl.uniform1f(u.u_ringO, cam.ringO);
    gl.uniform3f(u.u_cam, c.pos[0], c.pos[1], c.pos[2]);
    gl.uniform3f(u.u_fwd, c.fwd[0], c.fwd[1], c.fwd[2]);
    gl.uniform3f(u.u_up, c.up[0], c.up[1], c.up[2]);
    gl.uniform1f(u.u_tan, cam.tanHalf);
    gl.uniform1f(u.u_k, p.thickness);
    gl.uniform2f(u.u_flow, cam.fu, cam.fv);
    gl.uniform1f(u.u_side, cam.side);
    gl.uniform1f(u.u_mix, cam.mix);
    gl.uniform1f(u.u_fade, cam.fade);
    gl.uniform1i(u.u_steps, steps);
    gl.activeTexture(gl.TEXTURE0 + MAP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_dispMap, MAP_UNIT);
    gl.uniform1f(u.u_amp, amp);
    gl.uniform1f(u.u_dmax, dmax);
    gl.uniform1f(u.u_stepK, stepK);
  };

  return {
    frame(audio, time) {
      mapParams(ctx.params, p);
      p.height = ctx.size.height;
      p.reduceMotion = ctx.reduceMotion;
      p.reduceFlashing = ctx.reduceFlashing;
      const s = state.step(audio, time.dt, p);
      latticeCounts(p.symmetry, p.thickness, counts);
      camIn.view = p.view;
      camIn.thickness = p.thickness;
      camIn.stepped = s.stepped;
      camIn.reduceMotion = ctx.reduceMotion;
      cam.step(time.dt, s, camIn);
      // The waveform rolls round the tube from the hole: one history row per push, the beat
      // stamped into the row being laid down (s.env: 80 ms smoothstep rise, gone by 0.9 beat),
      // the bass baked into its height.
      waveIn.travel = p.travel;
      waveIn.detail = p.detail;
      waveIn.env = s.env;
      waveIn.bassAtt = audio.silent ? 1 : audio.bassAtt;
      waveIn.reactivity = audio.silent ? 0 : p.reactivity;
      history.step(audio.waveform, time.dt, waveIn);
      amp = canMap ? waveAmp(p.wave, p.thickness) : 0;
      dmax = liveDisp(history, amp); // ≤ maxDisp (≤ 0.45 k): the inside camera stays clear
      stepK = stepFactor(history, amp, p.thickness);
      if (canMap) renderMap();
      tess.render(s, surface);
    },

    pointer(e) {
      cam.pointer(e);
    },

    resize() {
      tess.resize();
    },

    params(changed) {
      if ("quality" in changed) setQuality();
    },

    dispose() {
      gl.deleteTexture(waveTex);
      gl.deleteTexture(mapTex);
      gl.deleteFramebuffer(mapFbo);
      gl.deleteProgram(dispProg.program);
      gl.deleteVertexArray(dispVao);
      tess.dispose();
    },
  };
}
