// @ts-check
/**
 * Tidalviz template: one full-screen fragment shader fed with audio uniforms.
 * Edit src/scene.frag for the look; edit this file to pass more data in.
 */
import { createFlashLimiter } from "./flash.js";

// A single triangle that covers the screen, generated from gl_VertexID (no buffers needed).
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const program = link(gl, VERTEX, await ctx.assets.text("src/scene.frag"));
  const vao = gl.createVertexArray();
  const loc = (/** @type {string} */ name) => gl.getUniformLocation(program, name);
  const u = {
    resolution: loc("u_resolution"),
    time: loc("u_time"),
    bass: loc("u_bass"),
    mid: loc("u_mid"),
    treb: loc("u_treb"),
    beat: loc("u_beat"),
    flash: loc("u_flash"),
    bands: loc("u_bands"),
    color: loc("u_color"),
    intensity: loc("u_intensity"),
  };

  // Allocate everything up front; frame() must not create objects (60+ times a second).
  const color = new Float32Array(3);
  const flash = createFlashLimiter();
  let kick = 0;

  function readParams() {
    const n = parseInt(String(ctx.params.color).slice(1), 16) || 0;
    color[0] = ((n >> 16) & 255) / 255;
    color[1] = ((n >> 8) & 255) / 255;
    color[2] = (n & 255) / 255;
  }
  readParams();

  return {
    frame(audio, time) {
      // Onsets kick a decaying envelope; the limiter caps it at 3 flashes/s when the user
      // has "Reduce flashing" on (the default).
      kick = audio.onset ? 1 : kick * Math.exp(-time.dt * 6);
      const flashLevel = flash.step(kick, time.dt, ctx.reduceFlashing);

      gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      // Transparent canvas: clear to 0,0,0,0, never opaque black (see the end of scene.frag).
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform2f(u.resolution, ctx.size.width, ctx.size.height);
      gl.uniform1f(u.time, time.now);
      gl.uniform1f(u.bass, audio.bassAtt);
      gl.uniform1f(u.mid, audio.midAtt);
      gl.uniform1f(u.treb, audio.trebAtt);
      gl.uniform1f(u.beat, audio.bpm > 0 ? (1 - audio.beatPhase) ** 2 : 0);
      gl.uniform1f(u.flash, flashLevel);
      gl.uniform1fv(u.bands, audio.bands); // zero-copy: the typed array goes straight to GL
      gl.uniform3fv(u.color, color);
      gl.uniform1f(u.intensity, Number(ctx.params.intensity));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    params() {
      readParams();
    },

    dispose() {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

/**
 * Compile and link, throwing the GLSL log so it shows in the dev overlay.
 * @param {WebGL2RenderingContext} gl
 * @param {string} vs
 * @param {string} fs
 */
function link(gl, vs, fs) {
  const program = /** @type {WebGLProgram} */ (gl.createProgram());
  for (const [type, src, name] of /** @type {const} */ ([
    [gl.VERTEX_SHADER, vs, "vertex shader"],
    [gl.FRAGMENT_SHADER, fs, "src/scene.frag"],
  ])) {
    const shader = /** @type {WebGLShader} */ (gl.createShader(type));
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`${name}: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
