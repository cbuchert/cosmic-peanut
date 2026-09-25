// Spike "SDK" + WebGL2 plugin in one: receives transferred frames over the port,
// renders a full-window shader on rAF, and records arrival/consume timing.
import { now } from "./util.js"; // static relative import

const FS = `#version 300 es
precision highp float;
uniform sampler2D uSpec; uniform float uT; uniform vec2 uRes; uniform float uBass;
out vec4 o;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec2 p = uv*6.0;
  float v = 0.0, a = 0.5;
  for (int i=0;i<6;i++){ v += a*n(p + uT*0.3); p *= 2.02; a *= 0.5; }
  float s = texture(uSpec, vec2(uv.x, 0.5)).r;
  float bar = step(uv.y, s*0.8);
  o = vec4(vec3(v*0.6, v*0.3 + bar*0.5, 0.4 + 0.4*uBass) , 1.0);
}`;
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0,1); }`;

export async function boot(cfg) {
  self.__moduleRan = true;
  try { self.__dep = (await import("dep")).dep; } catch (e) { self.__depError = String(e); }
  if (cfg.probeOnly) return;

  const info = { cfg, origin: self.origin, dep: self.__dep || null, depError: self.__depError || null,
    ua: navigator.userAgent, dpr: devicePixelRatio, inner: [innerWidth, innerHeight],
    timeOrigin: performance.timeOrigin, hasGpu: "gpu" in navigator };

  const port = await new Promise((res) => {
    addEventListener("message", function once(e) {
      if (e.source === parent && e.data && e.data.type === "tidalviz:init" && e.ports[0]) {
        removeEventListener("message", once); res(e.ports[0]);
      }
    });
  });

  if (navigator.gpu) {
    try {
      const ad = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
      info.gpuAdapter = ad === "timeout" ? "timeout" : ad ? { features: [...ad.features].length, info: ad.info ? { vendor: ad.info.vendor, arch: ad.info.architecture } : null } : null;
    } catch (e) { info.gpuAdapter = "error: " + e; }
  }

  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
  info.webgl2 = !!gl;
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    info.glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    info.glVersion = gl.getParameter(gl.VERSION);
    info.floatTex = !!gl.getExtension("OES_texture_float_linear");
  }
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1024, 1, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const uT = gl.getUniformLocation(prog, "uT"), uRes = gl.getUniformLocation(prog, "uRes"), uBass = gl.getUniformLocation(prog, "uBass");

  const rec = { sizes: [], arrive: [], consume: [], rafTs: [], rafNow: [], drawMs: [], vis: [], skipped: 0, consumed: 0 };
  document.addEventListener("visibilitychange", () => rec.vis.push([now(), document.visibilityState]));
  rec.vis.push([now(), document.visibilityState]);
  let latest = null;

  port.onmessage = (e) => {
    const d = e.data;
    if (d instanceof ArrayBuffer) {
      const t = now();
      const dv = new DataView(d);
      const idx = dv.getUint32(8, true);
      if (latest && !latest.used) rec.skipped++;
      latest = { buf: d, idx, t, used: false };
      if (rec.arrive.length < 200000) rec.arrive.push([idx, t]);
      return;
    }
    if (d.type === "ping") port.postMessage({ type: "pong", t0: d.t0, ts: now() });
    else if (d.type === "dump") {
      info.canvas = [canvas.width, canvas.height]; info.inner = [innerWidth, innerHeight]; info.dpr = devicePixelRatio;
      port.postMessage({ type: "results", info, rec });
    }
  };

  let ready = false;
  function frame(ts) {
    const t = now();
    if (rec.rafTs.length < 100000) { rec.rafTs.push(performance.timeOrigin + ts); rec.rafNow.push(t); }
    const w = Math.round(innerWidth * devicePixelRatio), h = Math.round(innerHeight * devicePixelRatio);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; rec.sizes.push([t, w, h, innerWidth, innerHeight, devicePixelRatio]); }
    const d0 = performance.now();
    if (latest && !latest.used) {
      latest.used = true; rec.consumed++;
      rec.consume.push([latest.idx, t, performance.timeOrigin + ts]);
      const f = new Float32Array(latest.buf, 32 + 16 * 4 + 64 * 4, 1024); // spectrum view, zero-copy
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, 1, gl.RED, gl.FLOAT, f);
      gl.uniform1f(uBass, new Float32Array(latest.buf, 32, 16)[2]);
    }
    gl.viewport(0, 0, w, h);
    gl.uniform1f(uT, ts / 1000); gl.uniform2f(uRes, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (rec.drawMs.length < 100000) rec.drawMs.push(performance.now() - d0);
    if (!ready) { ready = true; port.postMessage({ type: "ready", info }); if (cfg.hang) setTimeout(() => { port.postMessage({ type: "hanging", at: now() }); for (;;) {} }, 3000); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
