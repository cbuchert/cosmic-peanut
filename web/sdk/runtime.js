// @ts-check
/**
 * The SDK runtime that runs inside each plugin iframe: plugin lifecycle, render loop, port
 * messages, sizing, quality, errors and perf. DOM-free: every browser dependency (port, clock,
 * rAF, context factory, entry loader, fetch) is injected, so it is unit-tested with fakes.
 * `sdk.js` wires it to the real window.
 */

import { createAudioFrame, decodeInto, peekFlags } from "./frame.js";
import { createAssets } from "./assets.js";
import { describeError, formatLog } from "./diagnostics.js";

/** @typedef {import("./tidalviz").Visualizer} Visualizer */
/** @typedef {import("./tidalviz").VisualizerContext} VisualizerContext */
/** @typedef {import("./tidalviz").VisualizerManifestEntry} ManifestEntry */
/** @typedef {import("./tidalviz").QualityMode} QualityMode */

/**
 * @typedef {{
 *   ctx2d: CanvasRenderingContext2D | null,
 *   gl: WebGL2RenderingContext | null,
 *   gpu: import("./tidalviz").WebGPUHandles | null,
 *   three: import("./tidalviz").ThreeHandles | null,
 * }} RendererHandles
 */

/**
 * @typedef {{
 *   port: { postMessage(message: unknown): void },
 *   init: Record<string, unknown>,
 *   manifest: ManifestEntry,
 *   base: string,
 *   canvas: HTMLCanvasElement,
 *   cssSize: { width: number, height: number },
 *   loadEntry: () => Promise<{ default?: unknown }>,
 *   createContext: (kind: import("./tidalviz").RendererKind, canvas: HTMLCanvasElement) => Promise<RendererHandles>,
 *   raf: (cb: (ts: number) => void) => number,
 *   caf: (id: number) => void,
 *   now: () => number,
 *   devicePixelRatio: () => number,
 *   fetch: (url: string) => Promise<Response>,
 *   createImageBitmap?: (b: Blob) => Promise<ImageBitmap>,
 * }} RuntimeDeps
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v @returns {v is import("./tidalviz").ParamValue} */
const isParamValue = (v) => typeof v === "number" || typeof v === "string" || typeof v === "boolean";

/**
 * Keep only valid param values.
 * @param {unknown} v
 * @returns {Record<string, import("./tidalviz").ParamValue>}
 */
function sanitizeParams(v) {
  /** @type {Record<string, import("./tidalviz").ParamValue>} */
  const out = {};
  if (!isObject(v)) return out;
  for (const [k, val] of Object.entries(v)) if (isParamValue(val)) out[k] = val;
  return out;
}

/** @param {RuntimeDeps} deps */
export function createRuntime(deps) {
  const { port, manifest, canvas } = deps;
  const init = deps.init;

  // ---- settings (live) -------------------------------------------------------------------
  /** @type {QualityMode} */
  let quality = "auto";
  let reduceFlashing = true;
  let renderScale = 1;
  let visible = init.visible !== false;
  if (typeof init.reduceFlashing === "boolean") reduceFlashing = init.reduceFlashing;
  if (init.quality === "auto" || init.quality === "high" || init.quality === "balanced" || init.quality === "battery") {
    quality = init.quality;
  }

  /** @type {Record<string, import("./tidalviz").ParamValue>} */
  const params = {};
  for (const spec of manifest.params ?? []) params[spec.id] = spec.default;
  Object.assign(params, sanitizeParams(init.params));

  // ---- size ------------------------------------------------------------------------------
  let cssWidth = deps.cssSize.width, cssHeight = deps.cssSize.height;
  const size = { width: 1, height: 1, cssWidth: 0, cssHeight: 0, dpr: 1 };

  function applySize() {
    const dpr = deps.devicePixelRatio() * renderScale;
    size.cssWidth = cssWidth;
    size.cssHeight = cssHeight;
    size.dpr = dpr;
    size.width = Math.max(1, Math.round(cssWidth * dpr));
    size.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.width = size.width;
    canvas.height = size.height;
  }

  // ---- plugin ----------------------------------------------------------------------------
  /** @type {VisualizerContext | null} */
  let ctx = null;
  /** @type {Visualizer | null} */
  let plugin = null;
  let readySent = false;
  let dead = false; // fatal error or disposed: never render again
  let consecutiveErrors = 0;

  /**
   * @param {unknown} err
   * @param {boolean} fatal
   */
  function postError(err, fatal) {
    port.postMessage({ type: "error", ...describeError(err, deps.base), fatal });
  }

  /** @param {unknown} err */
  function fail(err) {
    dead = true;
    stopLoop();
    postError(err, true);
  }

  const audio = createAudioFrame();
  /** @type {ArrayBuffer | null} newest undecoded frame */
  let pending = null;
  const time = { now: 0, dt: 0, frame: 0 };

  // ---- loop ------------------------------------------------------------------------------
  let rafId = 0;
  let lastTs = -1;

  /** @param {number} ts */
  function tick(ts) {
    rafId = deps.raf(tick);
    if (pending) {
      decodeInto(audio, pending);
      pending = null;
    }
    const elapsed = lastTs < 0 ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;
    time.now += elapsed;
    time.dt = Math.min(0.1, elapsed);
    try {
      /** @type {Visualizer} */ (plugin).frame(audio, time);
      consecutiveErrors = 0;
    } catch (err) {
      time.frame++;
      if (++consecutiveErrors >= 3) fail(err);
      else postError(err, false);
      return;
    }
    time.frame++;
    if (!readySent) {
      readySent = true;
      port.postMessage({ type: "ready" });
    }
  }

  function stopLoop() {
    if (rafId) deps.caf(rafId);
    rafId = 0;
  }

  function startLoop() {
    if (rafId || !plugin || !visible || dead) return;
    lastTs = -1;
    rafId = deps.raf(tick);
  }

  /** Create the context and the plugin, then start the loop. Never rejects: failures are fatal. */
  async function start() {
    try {
      await createPlugin();
    } catch (err) {
      fail(err);
      return;
    }
    startLoop();
  }

  async function createPlugin() {
    applySize();
    const handles = await deps.createContext(manifest.renderer, canvas);
    const assets = createAssets(deps.base, { fetch: deps.fetch, createImageBitmap: deps.createImageBitmap });
    ctx = {
      apiVersion: 1,
      id: manifest.id,
      name: manifest.name,
      renderer: manifest.renderer,
      canvas,
      ctx2d: handles.ctx2d,
      gl: handles.gl,
      gpu: handles.gpu,
      three: handles.three,
      params,
      assets,
      size,
      get renderScale() {
        return renderScale;
      },
      get quality() {
        return quality;
      },
      get reduceFlashing() {
        return reduceFlashing;
      },
      log(...args) {
        port.postMessage({ type: "log", text: formatLog(args) });
      },
    };
    const mod = await deps.loadEntry();
    if (typeof mod.default !== "function") {
      throw new Error(`${manifest.entry}: the default export must be a create(ctx) function`);
    }
    const create = /** @type {import("./tidalviz").CreateVisualizer} */ (mod.default);
    const vis = await create(ctx);
    if (!isObject(vis) || typeof vis.frame !== "function") {
      throw new Error("create(ctx) must return an object with a frame(audio, time) function");
    }
    plugin = vis;
  }

  /** @param {unknown} data a port message */
  function handleMessage(data) {
    if (data instanceof ArrayBuffer) {
      try {
        peekFlags(data);
      } catch {
        return;
      }
      pending = data;
    }
  }

  return {
    start,
    handleMessage,
    /** Errors outside create/frame (window `error`, `unhandledrejection`). @param {unknown} err */
    reportError(err) {
      postError(err, false);
    },
  };
}
