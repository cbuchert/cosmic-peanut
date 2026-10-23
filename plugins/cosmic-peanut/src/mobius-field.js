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
 *
 * Look (./lib/look.js): classic is all of the above, call for call. Cinematic draws the same bands
 * as prefiltered line quads (./lib/quads.js, shaders/quad-field.vert) into a float scene, with depth
 * of field focused on the nearest band ahead (./lib/dof.js, field.js `ahead`), then blooms, tone
 * maps and composites it (./lib/cinema.js). Its GL objects exist only while it is the Look.
 */
import { BREATH, STAMP, breath, createBeat, createGlow, stamp, wring } from "./lib/beat.js";
import { CINEMA_ASSETS, createCinema, includeQuad } from "./lib/cinema.js";
import { createFocus } from "./lib/dof.js";
import { INST, createField, fieldCount, rowLag } from "./lib/field.js";
import { NOMINAL_SPEED, createFly } from "./lib/fly.js";
import { buildGrid } from "./lib/geometry.js";
import { createProgram } from "./lib/gl.js";
import { createHistory } from "./lib/history.js";
import { CINEMA, lookMode } from "./lib/look.js";
import { GENTLE, gentle } from "./lib/motion.js";
import { densityRings, paletteIndex, paramDefault, renderPath, ringGain } from "./lib/params.js";
import { PULSE_MAX, createPulse, swell } from "./lib/pulse.js";
import { buildQuadGrid } from "./lib/quads.js";
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
/** Cinematic depth of field: where focus starts (and stays, under Reduce motion), in Fog distances. */
const FOCUS_START = 0.3;
/** The focus target is kept within this span of Fog distances (nearest band ahead, or the start). */
const FOCUS_SPAN = [0.08, 0.9];
/**
 * Cinematic level of detail: bands nearer than LOD_UNTIL[0] units draw every STRIDE-th point of a
 * slice, as classic does; then every 4th, then every 8th. A band's slice shrinks on screen with
 * distance, so this keeps about the same points per pixel (~1.4 per CSS px at each boundary);
 * the far bands are also blurred by the depth of field. Most bands in view are far (at Fog 14,
 * ~80% are beyond 8 units), so it cuts the vertex work to about a third.
 */
const LOD_STRIDES = [STRIDE, 4, 8];
const LOD_UNTIL = new Float64Array([4, 8]);
/** The per-band attributes' byte offsets in an instance (aOff, aRot, aBand). */
const ATTR_OFFSETS = [0, 16, 32];

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const [vs, fs, blitVs, blitFs, manifest, quadVs, quadFs, quadLib, down, up, composite] = await Promise.all([
    ctx.assets.text("shaders/field.vert"),
    ctx.assets.text("shaders/field.frag"),
    ctx.assets.text("shaders/blit.vert"),
    ctx.assets.text("shaders/blit.frag"),
    ctx.assets.json("tidalviz.json"),
    ctx.assets.text("shaders/quad-field.vert"),
    ctx.assets.text("shaders/quad-field.frag"),
    ctx.assets.text(CINEMA_ASSETS.quad),
    ctx.assets.text(CINEMA_ASSETS.down),
    ctx.assets.text(CINEMA_ASSETS.up),
    ctx.assets.text(CINEMA_ASSETS.composite),
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

  /**
   * The cinematic look's GL objects: its target and post chain, line program, and one quad grid
   * and VAO per detail level (LOD), each reading its share of the instance buffer. Made when Look
   * turns cinematic, deleted when it turns classic.
   * @typedef {{ stride: number, vao: WebGLVertexArrayObject, vbo: WebGLBuffer | null, ibo: WebGLBuffer | null, count: number }} Level
   * @type {{ target: ReturnType<typeof createCinema>, prog: ReturnType<typeof createProgram>, locs: number[], levels: Level[] } | null}
   */
  let cine = null;
  const focus = createFocus(FOCUS_START * fog);

  /** Each level's quad grid for the current density (M / stride + 1 points per slice, both sides). */
  function allocateQuads() {
    if (!cine) return;
    for (const level of cine.levels) {
      const { verts, indices } = buildQuadGrid(history.N - rowLag(history.N), M / level.stride + 1);
      level.count = indices.length;
      gl.bindVertexArray(level.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, level.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, false, 0, 0); // read as float (2j + side, i)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, level.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      for (const loc of cine.locs) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribDivisor(loc, 1);
      }
    }
    gl.bindVertexArray(null);
  }

  /** Make or delete the cinematic look's objects to match the Look param. */
  function setLook() {
    const want = lookMode(ctx.params.look) === "cinematic";
    if (want && !cine) {
      const quad = createProgram(gl, includeQuad(quadVs, quadLib), quadFs, "shaders/quad-field");
      cine = {
        target: createCinema(gl, ctx, { blitVs, down, up, composite }, { css: true }),
        prog: quad,
        locs: ["aOff", "aRot", "aBand"].map((n) => gl.getAttribLocation(quad.program, n)),
        levels: LOD_STRIDES.map((stride) => ({
          stride,
          vao: /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray()),
          vbo: gl.createBuffer(),
          ibo: gl.createBuffer(),
          count: 0,
        })),
      };
      allocateQuads();
      soft.release();
    } else if (!want && cine) {
      disposeCine();
      soft.resize();
    }
  }

  function disposeCine() {
    if (!cine) return;
    cine.target.dispose();
    gl.deleteProgram(cine.prog.program);
    for (const level of cine.levels) {
      gl.deleteVertexArray(level.vao);
      gl.deleteBuffer(level.vbo);
      gl.deleteBuffer(level.ibo);
    }
    cine = null;
  }
  setLook();

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
      const bands = field.pack(fly.view, fly.tanX, fly.tanY, reach, rowLag(history.N), cine ? LOD_UNTIL : undefined);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, field.inst, 0, bands * INST);

      // Classic: the field program, straight or through the soft-lines target. Cinematic: the quad
      // program into the float scene; same uniforms, plus the look's.
      const P = cine ? cine.prog : prog;
      const U = P.u;
      if (cine) cine.target.begin();
      else soft.begin(path);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive: overlapping bands glow
      gl.useProgram(P.program);
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
      gl.uniform1f(U.uGain, ringGain(Number(p.bright), history.N, path === "canvas") * FIELD_GAIN * (cine ? CINEMA.fieldGain : 1));
      gl.uniform1f(U.uPalette, paletteIndex(p.palette));
      gl.uniform1f(U.uPulse, pulseAmt);
      gl.uniform1f(U.uGlow, glowAmt);
      gl.uniformMatrix4fv(U.uProj, false, fly.proj);
      gl.uniformMatrix4fv(U.uView, false, fly.view);
      if (cine) {
        // Focus eases to the nearest band ahead (the start distance if none); Reduce motion holds it.
        const ahead = field.ahead < Infinity ? field.ahead : FOCUS_START * fog;
        const target = Math.min(FOCUS_SPAN[1] * fog, Math.max(FOCUS_SPAN[0] * fog, ahead));
        const f = focus.step(target, dt, ctx.reduceMotion);
        cine.target.lineUniforms(U, path === "canvas", CINEMA.fieldWidth, f, CINEMA.fieldAperture, CINEMA.fieldCocMax);
        // One draw per detail level, each reading its range of the instance buffer.
        let first = 0;
        for (let l = 0; l < cine.levels.length; l++) {
          const level = cine.levels[l];
          const end = field.levelEnd[l];
          if (end > first) {
            gl.bindVertexArray(level.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
            for (let a = 0; a < 3; a++) {
              gl.vertexAttribPointer(cine.locs[a], 4, gl.FLOAT, false, INST * 4, first * INST * 4 + ATTR_OFFSETS[a]);
            }
            gl.uniform1i(U.uStride, level.stride);
            gl.drawElementsInstanced(gl.TRIANGLE_STRIP, level.count, gl.UNSIGNED_INT, 0, end - first);
          }
          first = end;
        }
        gl.disable(gl.BLEND);
        cine.target.end(time.now, ctx.reduceFlashing || ctx.reduceMotion, CINEMA.fieldBloom);
      } else {
        gl.bindVertexArray(vao);
        gl.drawElementsInstanced(gl.LINE_STRIP, indexCount, gl.UNSIGNED_INT, 0, bands);
        gl.disable(gl.BLEND);
        soft.end(path);
      }
      gl.bindVertexArray(null);
    },

    resize() {
      if (cine) cine.target.resize();
      else soft.resize();
    },

    params(changed) {
      if ("look" in changed) setLook();
      if (("antialias" in changed || "lines" in changed) && !cine) soft.resize();
      if ("density" in changed && history.setDensity(densityRings(changed.density))) {
        allocate();
        allocateQuads();
      }
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
      disposeCine();
    },
  };
}
