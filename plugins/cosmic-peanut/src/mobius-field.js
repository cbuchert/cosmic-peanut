// @ts-check
/**
 * Möbius Field — an endless field of glowing Möbius bands, the camera flying through them.
 * `webgl2` renderer. Every band is Möbius's closed band, drawn from one shared waveform history
 * (./lib/history.js, with the beat stamped in and each row's size baked in at push time, as on
 * Möbius) and a static (j, i) grid, all bands in one drawElementsInstanced call. The bands sit in a
 * box that wraps around the camera (./lib/field.js); only those lit and in view are packed into
 * the instance buffer each frame. The camera wanders along a smooth path and surges on the beat
 * (./lib/fly.js). The logic lives in ./lib (pure, tested); this file is the GL glue. frame()
 * allocates nothing.
 */
import { BREATH, STAMP, breath, createBeat, createGlow, stamp, wring } from "./lib/beat.js";
import { INST, createField, fieldCount, rowLag } from "./lib/field.js";
import { NOMINAL_SPEED, createFly } from "./lib/fly.js";
import { buildGrid } from "./lib/geometry.js";
import { createProgram } from "./lib/gl.js";
import { createHistory } from "./lib/history.js";
import { GENTLE, gentle } from "./lib/motion.js";
import { densityRings, paletteIndex, paramDefault, renderPath, ringGain } from "./lib/params.js";
import { PULSE_MAX, createPulse, swell } from "./lib/pulse.js";
import { RING_CLAMP } from "./lib/ring.js";
import { createSnake } from "./lib/snake.js";
import { createSoftTarget } from "./lib/soft.js";

/** Points per ring in the history (as on Möbius). */
const M = 512;
/** The field's grid draws every STRIDE-th point across each slice (budget: see the README). */
const STRIDE = 2;
/** Layout seed: the same field every launch. */
const SEED = 7;
/** Line gain relative to the single strip's (many bands overlap, each smaller on screen). */
const FIELD_GAIN = 0.3;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const [vs, fs, blitVs, blitFs, manifest] = await Promise.all([
    ctx.assets.text("shaders/field.vert"),
    ctx.assets.text("shaders/field.frag"),
    ctx.assets.text("shaders/blit.vert"),
    ctx.assets.text("shaders/blit.frag"),
    ctx.assets.json("tidalviz.json"),
  ]);
  // Manifest defaults decide whether the user has touched a motion param (reduced motion).
  const m = /** @type {import('../tidalviz').Manifest} */ (manifest);
  const pulseDefault = paramDefault(m, ctx.id, "pulse");
  const beatDefault = paramDefault(m, ctx.id, "beat");
  const speedDefault = paramDefault(m, ctx.id, "speed");

  const prog = createProgram(gl, vs, fs, "shaders/field");
  const U = prog.u;
  const aOff = gl.getAttribLocation(prog.program, "aOff");
  const aRot = gl.getAttribLocation(prog.program, "aRot");
  const aBand = gl.getAttribLocation(prog.program, "aBand");

  const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const instBuf = gl.createBuffer();
  const hist = gl.createTexture();
  const posTex = gl.createTexture();
  let indexCount = 0;

  // Each pushed row keeps the size it was laid at (beat breath × bass swell): the snake's place
  // table with the head standing still, so only its size column (uPos.g) is read.
  const sizes = createSnake(densityRings(ctx.params.density));
  let size = 1;
  const history = createHistory(M, densityRings(ctx.params.density), (row, ring) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, M, 1, gl.RED, gl.FLOAT, ring);
    sizes.place(row, 0, 0, size);
  });

  const fly = createFly();
  const pulse = createPulse();
  const beat = createBeat();
  const glow = createGlow();
  let fog = Number(ctx.params.fog);
  let field = createField(fieldCount(Number(ctx.params.bands)), SEED, fog);

  /** Grid, history texture and per-row sizes for the current density. Allocates; on change only. */
  function allocate() {
    const { verts, indices } = buildGrid(history.N - rowLag(history.N), M / STRIDE);
    indexCount = indices.length;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 0, 0); // read as float (j, i)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hist);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, M, history.N, 0, gl.RED, gl.FLOAT, history.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    sizes.resize(history.N);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, history.N, 1, 0, gl.RG, gl.FLOAT, sizes.pos);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The instance buffer, sized for every band in the field. Allocates; on a Bands change only. */
  function allocateBands() {
    const stride = INST * 4;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, field.inst.byteLength, gl.DYNAMIC_DRAW);
    for (const [loc, offset] of [
      [aOff, 0],
      [aRot, 16],
      [aBand, 32],
    ]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }
  allocate();
  allocateBands();

  const soft = createSoftTarget(gl, ctx, blitVs, blitFs);

  return {
    frame(audio, time) {
      const p = ctx.params;
      const dt = time.dt;
      const strength = gentle(Number(p.pulse), pulseDefault, ctx.reduceMotion, GENTLE.pulse);
      const beatAmt = Number(p.beat);
      const beatMotion = gentle(beatAmt, beatDefault, ctx.reduceMotion, GENTLE.beat);
      const surge = gentle(beatAmt, beatDefault, ctx.reduceMotion, GENTLE.surge);
      const speed = gentle(Number(p.speed), speedDefault, ctx.reduceMotion, GENTLE.speed);
      const amp = Number(p.amp);
      const halfWidth = Number(p.width);
      const path = renderPath(p.lines, p.antialias);

      // Push the rings that are due, stamped by the beat, each laid at this frame's size.
      beat.step(audio, dt);
      const pulseAmt = pulse.step(audio, dt) * strength;
      size = breath(beat.env, beatMotion) * swell(pulseAmt);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hist);
      const gain = stamp(beat.env, beatMotion);
      const pushed = history.step(audio.waveform, dt, Number(p.travel), Number(p.detail), gain);
      if (pushed > 0) {
        gl.activeTexture(gl.TEXTURE2); // the sizes live on unit 2; unit 0 keeps the history
        gl.bindTexture(gl.TEXTURE_2D, posTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, history.N, 1, gl.RG, gl.FLOAT, sizes.pos);
        gl.activeTexture(gl.TEXTURE0);
      }
      const glowAmt = glow.step(beat.env, beatAmt, dt, ctx.reduceFlashing);

      // Fly on, spin the bands (slower with Reduce motion), and pack the ones in view.
      fly.update(dt, speed, beat.env, surge);
      field.spin(ctx.reduceMotion ? (dt * GENTLE.speed) / NOMINAL_SPEED : dt);
      const { width, height } = ctx.size;
      // A band's bounding radius at scale 1: the loop, the strip's half width and the waveform,
      // at the biggest size and stamp a slice can be laid at.
      const most = (1 + BREATH * beatMotion) * swell(PULSE_MAX * strength);
      const reach = 1 + most * (halfWidth + amp * RING_CLAMP * (1 + STAMP * beatMotion));
      fly.writeMatrices(width / height, fog + reach);
      field.place(fly.pos, reach);
      const bands = field.pack(fly.view, fly.tanX, fly.tanY, reach, rowLag(history.N));
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, field.inst, 0, bands * INST);

      soft.begin(path);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive: overlapping bands glow
      gl.useProgram(prog.program);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, posTex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hist);
      gl.uniform1i(U.uHist, 0);
      gl.uniform1i(U.uPos, 2);
      gl.uniform1i(U.uHead, history.head);
      gl.uniform1i(U.uN, history.N);
      gl.uniform1i(U.uM, M);
      gl.uniform1i(U.uStride, STRIDE);
      gl.uniform1i(U.uSlices, history.N - rowLag(history.N));
      gl.uniform1f(U.uFrac, history.frac);
      gl.uniform1f(U.uAmp, amp);
      gl.uniform1f(U.uWidth, halfWidth);
      gl.uniform1f(U.uTwist, wring(beat.swing, beatMotion));
      gl.uniform1f(U.uGain, ringGain(Number(p.bright), history.N, path === "canvas") * FIELD_GAIN);
      gl.uniform1f(U.uPalette, paletteIndex(p.palette));
      gl.uniform1f(U.uPulse, pulseAmt);
      gl.uniform1f(U.uGlow, glowAmt);
      gl.uniformMatrix4fv(U.uProj, false, fly.proj);
      gl.uniformMatrix4fv(U.uView, false, fly.view);
      gl.bindVertexArray(vao);
      gl.drawElementsInstanced(gl.LINE_STRIP, indexCount, gl.UNSIGNED_INT, 0, bands);
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
      if ("bands" in changed) {
        field = createField(fieldCount(Number(changed.bands)), SEED, fog);
        allocateBands();
      }
      if ("fog" in changed) {
        fog = Number(changed.fog);
        field.setFog(fog, fly.pos);
      }
    },

    pointer(e) {
      fly.pointer(e);
    },

    dispose() {
      gl.deleteBuffer(vbo);
      gl.deleteBuffer(ibo);
      gl.deleteBuffer(instBuf);
      gl.deleteTexture(hist);
      gl.deleteTexture(posTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
      soft.dispose();
    },
  };
}
