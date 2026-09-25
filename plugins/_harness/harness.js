// @ts-check
/**
 * Throwaway fake SDK (not shipped). Loads one visualizer from a local repo folder, feeds it
 * synthetic audio on rAF, and publishes timing stats on `window.__stats()`.
 *
 * Query: ?repo=builtin&viz=bars[&rep=N][&reduce=0|1][&strobe=1][&finish=1][&lum=1][&p.<id>=v]
 *   finish=1  gl.finish() inside the timed region, so the number includes GPU work
 *   lum=1     record mean frame luminance (for the flash-limiter check)
 */
import { createSynth } from "./synth.js";

const q = new URLSearchParams(location.search);
const repo = q.get("repo") ?? "builtin";
const vizId = q.get("viz") ?? "bars";
const finish = q.get("finish") === "1";
const measureLum = q.get("lum") === "1";
// WebKit coarsens performance.now() to 1 ms; rep=N runs frame() N times per rAF and divides.
const rep = Number(q.get("rep") ?? 1);
const base = `/plugins/${repo}/`;
const w = /** @type {any} */ (window);

/** @type {string[]} */
const errors = [];
w.__errors = errors;
addEventListener("error", (e) => errors.push(String(e.message)));
addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.stack ?? e.reason)));

async function main() {
  const manifest = await (await fetch(base + "tidalviz.json")).json();
  const entry = manifest.visualizers.find((/** @type {any} */ v) => v.id === vizId);
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("c"));
  const dpr = devicePixelRatio;
  const size = { width: 0, height: 0, cssWidth: 0, cssHeight: 0, dpr };
  const setSize = (/** @type {number} */ cw, /** @type {number} */ ch) => {
    Object.assign(size, { cssWidth: cw, cssHeight: ch, width: Math.round(cw * dpr), height: Math.round(ch * dpr) });
    canvas.width = size.width;
    canvas.height = size.height;
  };
  setSize(innerWidth, innerHeight);

  /** @type {Record<string, any>} */
  const params = {};
  for (const p of entry.params ?? []) params[p.id] = p.default;
  for (const [k, v] of q) {
    if (!k.startsWith("p.")) continue;
    const id = k.slice(2);
    params[id] = typeof params[id] === "number" ? Number(v) : typeof params[id] === "boolean" ? v === "true" : v;
  }

  /** @type {any} */
  const ctx = {
    apiVersion: 1, id: entry.id, name: entry.name, renderer: entry.renderer, canvas,
    ctx2d: null, gl: null, gpu: null, three: null,
    params, size, renderScale: 1, quality: "high",
    reduceFlashing: q.get("reduce") !== "0",
    log: (/** @type {unknown[]} */ ...a) => console.log("[plugin]", ...a),
    assets: {
      url: (/** @type {string} */ p) => new URL(p, location.origin + base).href,
      text: async (/** @type {string} */ p) => (await fetch(base + p)).text(),
      json: async (/** @type {string} */ p) => (await fetch(base + p)).json(),
      arrayBuffer: async (/** @type {string} */ p) => (await fetch(base + p)).arrayBuffer(),
      image: async (/** @type {string} */ p) => createImageBitmap(await (await fetch(base + p)).blob()),
    },
  };
  /** @type {WebGL2RenderingContext | null} */
  let gl = null;
  if (entry.renderer === "2d") ctx.ctx2d = canvas.getContext("2d", { alpha: false });
  if (entry.renderer === "webgl2") {
    gl = ctx.gl = canvas.getContext("webgl2", { powerPreference: "high-performance", antialias: false, preserveDrawingBuffer: false, alpha: false });
  }
  if (entry.renderer === "three") {
    const THREE = await import("three");
    const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: "high-performance", antialias: false });
    renderer.setPixelRatio(dpr);
    renderer.setSize(size.cssWidth, size.cssHeight, false);
    const camera = new THREE.PerspectiveCamera(60, size.width / size.height, 0.1, 1000);
    camera.position.z = 5;
    ctx.three = { THREE, renderer, scene: new THREE.Scene(), camera, autoRender: true };
    gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());
  }
  w.__ctx = ctx;

  const mod = await import(base + entry.entry);
  const viz = await mod.default(ctx);

  w.__resize = (/** @type {number} */ cw, /** @type {number} */ ch) => {
    setSize(cw, ch);
    if (ctx.three) {
      ctx.three.renderer.setSize(cw, ch, false);
      if (ctx.three.camera.isPerspectiveCamera) {
        ctx.three.camera.aspect = cw / ch;
        ctx.three.camera.updateProjectionMatrix();
      }
    }
    viz.resize?.(size);
  };
  w.__setParam = (/** @type {string} */ id, /** @type {any} */ v) => {
    params[id] = v;
    viz.params?.({ [id]: v });
  };
  w.__dispose = () => {
    running = false;
    viz.dispose?.();
  };

  const synth = createSynth({ strobe: q.get("strobe") === "1" });
  /** @type {number[]} */ const times = [];
  /** @type {number[]} */ const intervals = [];
  /** @type {number[]} */ const lum = [];
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 18;
  const pg = /** @type {CanvasRenderingContext2D} */ (probe.getContext("2d", { willReadFrequently: true }));
  const time = { now: 0, dt: 0, frame: 0 };
  let running = true;
  let last = performance.now();
  const start = last;
  let frames = 0;

  /** @param {number} ts */
  function tick(ts) {
    if (!running) return;
    const dt = Math.min(0.1, (ts - last) / 1000);
    if (frames > 0) intervals.push(ts - last);
    last = ts;
    time.now = (ts - start) / 1000;
    time.dt = frames === 0 ? 1 / 60 : dt;
    time.frame = frames++;
    const audio = synth.update(time.now, time.dt);
    const t0 = performance.now();
    try {
      for (let r = 0; r < rep; r++) {
        viz.frame(audio, time);
        if (ctx.three?.autoRender) ctx.three.renderer.render(ctx.three.scene, ctx.three.camera);
        if (finish && gl) gl.finish();
      }
    } catch (e) {
      errors.push(String(/** @type {any} */ (e)?.stack ?? e));
    }
    times.push((performance.now() - t0) / rep);
    if (measureLum) {
      pg.drawImage(canvas, 0, 0, probe.width, probe.height);
      const d = pg.getImageData(0, 0, probe.width, probe.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum.push(s / (d.length / 4) / 255);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  w.__reset = () => {
    times.length = 0;
    intervals.length = 0;
    lum.length = 0;
  };
  w.__stats = () => {
    const pct = (/** @type {number[]} */ a, /** @type {number} */ p) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    };
    return {
      frames: times.length,
      p50: pct(times, 0.5),
      p99: pct(times, 0.99),
      max: Math.max(...times),
      fps: 1000 / pct(intervals, 0.5),
      intervalP99: pct(intervals, 0.99),
      size: [size.width, size.height],
      lum,
      errors,
    };
  };
  w.__ready = true;
}

main().catch((e) => {
  errors.push(String(e?.stack ?? e));
  w.__ready = true;
});
