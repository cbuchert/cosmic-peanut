// @ts-check
/**
 * Cosmic Peanut — each moment's waveform becomes a ring on an invisible sphere; rings drift from
 * the north pole to the south pole while the camera slowly orbits. `webgl2` renderer. The pack's
 * Möbius visualizer is the same module with another vertex shader (./lib/shapes.js): its rings
 * snake along a track (./lib/track.js, ./lib/snake.js; two more small textures, the track table
 * and each row's place on it), framed by the track's bounds, plus the beat's wring, breath, glow
 * and stamp (./lib/beat.js; zero for the sphere, which has no Beat).
 *
 * All geometry is computed on the GPU from a static (j, i) vertex grid and an M × N R32F history
 * texture used as a circular buffer, so a frame is a few uniforms, at most a few one-row uploads,
 * and one drawElements call (plus a blit in Soft lines mode). The logic lives in ./lib (pure,
 * tested); this file is the GL glue. frame() allocates nothing.
 */
import { cameraDistance, createCamera, fitTrack } from "./lib/camera.js";
import { breath, createBeat, createGlow, stamp, wring } from "./lib/beat.js";
import { buildGrid } from "./lib/geometry.js";
import { createProgram } from "./lib/gl.js";
import { createHistory } from "./lib/history.js";
import { GENTLE, gentle } from "./lib/motion.js";
import { densityRings, paletteIndex, paramDefault, renderPath, ringGain } from "./lib/params.js";
import { createPulse, swell } from "./lib/pulse.js";
import { shapeFor } from "./lib/shapes.js";
import { createSoftTarget } from "./lib/soft.js";
import { createSnake, headSpeed } from "./lib/snake.js";
import { TRACKS, TRACK_SAMPLES, buildTrack, trackIndex } from "./lib/track.js";

/** Points per ring: high, so the waveform stays jagged. */
const M = 512;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const shape = shapeFor(ctx.id);
  const [ringVs, ringFs, blitVs, blitFs, manifest] = await Promise.all([
    ctx.assets.text(shape.vert),
    ctx.assets.text("shaders/rings.frag"),
    ctx.assets.text("shaders/blit.vert"),
    ctx.assets.text("shaders/blit.frag"),
    ctx.assets.json("tidalviz.json"),
  ]);
  // Manifest defaults decide whether the user has touched Orbit speed / Bass pulse (reduced motion).
  const m = /** @type {import('../tidalviz').Manifest} */ (manifest);
  const orbitDefault = paramDefault(m, ctx.id, "orbit");
  const pulseDefault = paramDefault(m, ctx.id, "pulse");
  const beatDefault = paramDefault(m, ctx.id, "beat"); // NaN for the sphere

  const rings = createProgram(gl, ringVs, ringFs, "shaders/rings");
  const U = rings.u;

  const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const hist = gl.createTexture();
  let indexCount = 0;

  // Möbius: the snake places each pushed row on the track at the head speed of this frame, with
  // the size it's laid at (beat breath × bass swell): those never touch slices already laid.
  const snake = createSnake(densityRings(ctx.params.density));
  let speed = 0;
  let size = 1;
  const history = createHistory(M, densityRings(ctx.params.density), (row, ring, ago) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, M, 1, gl.RED, gl.FLOAT, ring);
    if (shape.track) snake.place(row, ago, speed, size);
  });
  const trackTex = gl.createTexture();
  const posTex = gl.createTexture();
  /** @type {ReturnType<typeof buildTrack> | null} */
  let track = null;
  // Camera fit and depth-fade radius, recomputed only when what they depend on changes.
  let fitTrackName = "";
  let fitW = NaN;
  let fitAmp = NaN;
  let fitAspect = NaN;
  let fitDist = 0;
  let fitReach = 0;

  /** (Re)build the track table texture for the Track param. Allocates; param changes only. */
  function loadTrack() {
    const name = TRACKS[trackIndex(ctx.params.track)];
    if (track?.name === name) return;
    track = buildTrack(name);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, trackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TRACK_SAMPLES, 3, 0, gl.RGBA, gl.FLOAT, track.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
  }
  const camera = createCamera();
  const pulse = createPulse();
  const beat = createBeat();
  const glow = createGlow();

  /** Build the grid and a sentinel-filled history texture for the current density. */
  function allocate() {
    const { verts, indices } = buildGrid(history.N, M);
    indexCount = indices.length;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 0, 0); // read as float (j, i)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, hist);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, M, history.N, 0, gl.RED, gl.FLOAT, history.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    if (shape.track) {
      snake.resize(history.N);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, posTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, history.N, 1, 0, gl.RG, gl.FLOAT, snake.pos);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.activeTexture(gl.TEXTURE0);
    }
  }
  allocate();
  if (shape.track) loadTrack();

  const soft = createSoftTarget(gl, ctx, blitVs, blitFs);

  return {
    frame(audio, time) {
      const p = ctx.params;
      const dt = time.dt;
      const orbit = gentle(Number(p.orbit), orbitDefault, ctx.reduceMotion, GENTLE.orbit);
      const strength = gentle(Number(p.pulse), pulseDefault, ctx.reduceMotion, GENTLE.pulse);
      const amp = Number(p.amp);
      const halfWidth = Number(p.width); // Möbius only (NaN for the sphere, which ignores it)
      // Möbius only: the sphere has no Beat param, so 0, and its uniforms do nothing.
      const beatAmt = p.beat === undefined ? 0 : Number(p.beat);
      const beatMotion = gentle(beatAmt, beatDefault, ctx.reduceMotion, GENTLE.beat);
      const path = renderPath(p.lines, p.antialias);
      const fine = path === "canvas";

      // Push the rings that are due (fixed rate), one texSubImage2D row each; on Möbius the beat
      // envelope scales them, so each beat rides along the strip, and the snake's head advances
      // (surging gently on the beat) and places them on the track.
      beat.step(audio, dt);
      const pulseAmt = pulse.step(audio, dt) * strength;
      const travel = Number(p.travel);
      if (shape.track) {
        speed = headSpeed(Number(p.length), travel, beat.env, beatMotion);
        size = breath(beat.env, beatMotion) * swell(pulseAmt);
        snake.step(dt, speed);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hist);
      const pushed = history.step(audio.waveform, dt, travel, Number(p.detail), stamp(beat.env, beatMotion));
      if (shape.track && pushed > 0) {
        gl.activeTexture(gl.TEXTURE2); // the places live on unit 2; unit 0 keeps the history
        gl.bindTexture(gl.TEXTURE_2D, posTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, history.N, 1, gl.RG, gl.FLOAT, snake.pos);
        gl.activeTexture(gl.TEXTURE0);
      }
      const glowAmt = glow.step(beat.env, beatAmt, dt, ctx.reduceFlashing);

      camera.update(dt, orbit);
      const { width, height } = ctx.size;
      const aspect = width / height;
      let dist = 0;
      let extent = 0;
      if (track) {
        // Refit only when Track, Strip width, Amplitude or the aspect change.
        if (track.name !== fitTrackName || halfWidth !== fitW || amp !== fitAmp || aspect !== fitAspect) {
          fitTrackName = track.name;
          fitW = halfWidth;
          fitAmp = amp;
          fitAspect = aspect;
          fitDist = fitTrack(track, halfWidth, amp, aspect);
          fitReach = track.reach(halfWidth) + amp;
        }
        dist = fitDist;
        extent = fitReach;
      } else {
        extent = shape.extent(halfWidth);
        dist = cameraDistance(amp, aspect, extent);
      }
      camera.writeMatrices(aspect, dist);

      soft.begin(path);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive: overlapping rings glow
      gl.useProgram(rings.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hist);
      gl.uniform1i(U.uHist, 0);
      gl.uniform1i(U.uHead, history.head);
      gl.uniform1i(U.uN, history.N);
      gl.uniform1i(U.uM, M);
      gl.uniform1f(U.uFrac, history.frac);
      gl.uniform1f(U.uAmp, amp);
      gl.uniform1f(U.uRadius, extent);
      gl.uniform1f(U.uWidth ?? null, halfWidth);
      gl.uniform1f(U.uCamDist, dist);
      gl.uniform1f(U.uGain, ringGain(Number(p.bright), history.N, fine));
      gl.uniform1f(U.uPalette, paletteIndex(p.palette));
      gl.uniform1f(U.uPulse, pulseAmt);
      gl.uniform1f(U.uGlow ?? null, glowAmt);
      gl.uniform1f(U.uTwist ?? null, wring(beat.swing, beatMotion));
      if (shape.track) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, trackTex);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, posTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(U.uTrack ?? null, 1);
        gl.uniform1i(U.uPos ?? null, 2);
      }
      gl.uniformMatrix4fv(U.uProj, false, camera.proj);
      gl.uniformMatrix4fv(U.uView, false, camera.view);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.LINE_STRIP, indexCount, gl.UNSIGNED_INT, 0);
      gl.disable(gl.BLEND);

      soft.end(path);
      gl.bindVertexArray(null);
    },

    resize() {
      soft.resize();
    },

    params(changed) {
      if ("antialias" in changed || "lines" in changed) soft.resize();
      if ("density" in changed && history.setDensity(densityRings(changed.density))) allocate();
      if ("track" in changed && shape.track) loadTrack();
    },

    pointer(e) {
      camera.pointer(e);
    },

    dispose() {
      gl.deleteBuffer(vbo);
      gl.deleteBuffer(ibo);
      gl.deleteTexture(hist);
      gl.deleteTexture(trackTex);
      gl.deleteTexture(posTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(rings.program);
      soft.dispose();
    },
  };
}
