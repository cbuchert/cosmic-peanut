// @ts-check
/**
 * The SDK runtime that runs inside each plugin iframe: plugin lifecycle, render loop, port
 * messages, sizing, quality, errors and perf. DOM-free: every browser dependency (port, clock,
 * rAF, context factory, entry loader, fetch) is injected, so it is unit-tested with fakes.
 * `sdk.js` wires it to the real window.
 */

import { createAudioFrame, decodeInto, peekFlags, FLAG_ONSET } from "./frame.js";
import { createAssets } from "./assets.js";
import { describeError, formatLog } from "./diagnostics.js";
import { createQualityController } from "./quality.js";
import { createPerfMeter } from "./perf.js";

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
 *   reset?: () => void,
 * }} RendererHandles
 * `reset` restores per-instance defaults before a re-create after context loss (three: fresh
 * default scene/camera, autoRender on).
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

/** Default DPR cap per quality preset (0 = native). */
const PRESET_DPR = { auto: 0, high: 0, balanced: 1.5, battery: 1 };

/** @param {RuntimeDeps} deps */
export function createRuntime(deps) {
  const { port, manifest, canvas } = deps;
  const init = deps.init;

  // ---- settings (live) -------------------------------------------------------------------
  /** @type {QualityMode} */
  let quality = "auto";
  let reduceFlashing = true;
  let visible = init.visible !== false;
  let maxDpr = 0; // 0 = native devicePixelRatio
  let fpsCap = 0; // 0 = uncapped
  const DISPLAY_MS = 1000 / 60;
  const qc = createQualityController({ budgetMs: DISPLAY_MS });
  let renderScale = qc.scale;
  const perf = createPerfMeter({ expectedIntervalMs: DISPLAY_MS });

  /** @type {Record<string, import("./tidalviz").ParamValue>} */
  const params = {};
  for (const spec of manifest.params ?? []) params[spec.id] = spec.default;
  Object.assign(params, sanitizeParams(init.params));

  // ---- size ------------------------------------------------------------------------------
  let cssWidth = deps.cssSize.width, cssHeight = deps.cssSize.height;
  const size = { width: 1, height: 1, cssWidth: 0, cssHeight: 0, dpr: 1 };
  /** @type {import("./tidalviz").ThreeHandles | null} */
  let three = null;

  /** Recompute ctx.size and the drawing buffer. @returns {boolean} whether anything changed */
  function applySize(force = false) {
    const native = deps.devicePixelRatio() || 1;
    const dpr = (maxDpr > 0 ? Math.min(native, maxDpr) : native) * renderScale;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (!force && width === size.width && height === size.height && dpr === size.dpr &&
        cssWidth === size.cssWidth && cssHeight === size.cssHeight) return false;
    size.cssWidth = cssWidth;
    size.cssHeight = cssHeight;
    size.dpr = dpr;
    size.width = width;
    size.height = height;
    if (three) {
      three.renderer.setSize(width, height, false); // pixel ratio is pinned to 1
      const cam = /** @type {import("three").PerspectiveCamera} */ (three.camera);
      if (cam.isPerspectiveCamera) {
        cam.aspect = cssWidth / Math.max(1, cssHeight);
        cam.updateProjectionMatrix();
      }
    } else {
      canvas.width = width;
      canvas.height = height;
    }
    return true;
  }

  /** Re-apply size and tell the plugin when it changed. */
  function resize() {
    if (!applySize()) return;
    const p = plugin;
    if (p?.resize) guard(() => p.resize?.(size));
  }

  /**
   * Apply settings from init or a `settings` message. Invalid fields are ignored. When the
   * message sets `quality` without `maxDpr`/`fpsCap`, the preset's values are used.
   * @param {Record<string, unknown>} m
   */
  function applySettings(m) {
    if (typeof m.reduceFlashing === "boolean") reduceFlashing = m.reduceFlashing;
    if (m.quality === "auto" || m.quality === "high" || m.quality === "balanced" || m.quality === "battery") {
      quality = m.quality;
      qc.enabled = quality === "auto";
      qc.reset();
      if (m.maxDpr === undefined) maxDpr = PRESET_DPR[quality];
      if (m.fpsCap === undefined) fpsCap = quality === "battery" ? 30 : 0;
    }
    if (m.maxDpr === null || (typeof m.maxDpr === "number" && m.maxDpr >= 0)) maxDpr = m.maxDpr ?? 0;
    if (m.fpsCap === null || (typeof m.fpsCap === "number" && m.fpsCap >= 0)) fpsCap = m.fpsCap ?? 0;
    if (typeof m.renderScaleMax === "number" && m.renderScaleMax > 0) {
      qc.setMax(Math.min(1, Math.max(0.5, m.renderScaleMax)));
    }
    const budget = fpsCap > 0 ? 1000 / fpsCap : DISPLAY_MS;
    qc.setBudget(budget);
    perf.setExpectedInterval(budget);
    renderScale = qc.scale;
  }
  applySettings(init);

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
    /** @type {Record<string, unknown>} */
    const msg = { type: "error", ...describeError(err, deps.base), fatal };
    const fallback = /** @type {{ fallback?: unknown }} */ (err)?.fallback;
    if (typeof fallback === "string") msg.fallback = fallback;
    port.postMessage(msg);
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
  /** frameIndex of the first onset frame not yet rendered (survives frame replacement), or -1 */
  let latchedOnset = -1;
  const time = { now: 0, dt: 0, frame: 0 };

  // ---- loop ------------------------------------------------------------------------------
  let rafId = 0;
  let lastTs = -1;

  /** @param {number} ts */
  function tick(ts) {
    rafId = deps.raf(tick);
    // fps cap: skip display frames that come earlier than the cap allows (2 ms vsync slack)
    if (fpsCap > 0 && lastTs >= 0 && ts - lastTs < 1000 / fpsCap - 2) return;
    const t0 = deps.now();
    const intervalMs = lastTs < 0 ? 0 : ts - lastTs;
    if (lastTs < 0) perf.start(ts);
    let onsetIndex = -1;
    if (pending) {
      decodeInto(audio, pending);
      pending = null;
      if (latchedOnset >= 0) {
        audio.onset = true;
        onsetIndex = latchedOnset;
        latchedOnset = -1;
      }
    } else {
      audio.onset = false; // an onset is seen by exactly one rendered frame
    }
    lastTs = ts;
    time.now += intervalMs / 1000;
    time.dt = Math.min(0.1, intervalMs / 1000);

    const p0 = deps.now();
    let failed = null;
    try {
      /** @type {Visualizer} */ (plugin).frame(audio, time);
      if (three?.autoRender) three.renderer.render(three.scene, three.camera);
    } catch (err) {
      failed = { err };
    }
    const pluginMs = deps.now() - p0;
    time.frame++;
    if (onsetIndex >= 0) port.postMessage({ type: "onsetSeen", frameIndex: onsetIndex });

    if (failed) {
      if (++consecutiveErrors >= 3) fail(failed.err);
      else postError(failed.err, false);
      return;
    }
    consecutiveErrors = 0;
    if (!readySent) {
      readySent = true;
      port.postMessage({ type: "ready" });
    }
    if (intervalMs > 0 && qc.enabled && qc.sample(ts, intervalMs) !== renderScale) {
      renderScale = qc.scale;
      resize();
    }
    if (intervalMs > 0) perf.frame(intervalMs, pluginMs, deps.now() - t0 - pluginMs);
    const report = perf.report(ts);
    if (report) port.postMessage({ type: "perf", ...report, renderScale });
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

  /** @type {RendererHandles | null} */
  let handles = null;
  /** @type {import("./tidalviz").CreateVisualizer | null} */
  let create = null;
  let lost = false; // WebGL context lost, waiting for restore

  async function createPlugin() {
    applySize();
    handles = await deps.createContext(manifest.renderer, canvas);
    three = handles.three;
    if (three) applySize(true);
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
    create = /** @type {import("./tidalviz").CreateVisualizer} */ (mod.default);
    await instantiate();
  }

  /** Run the plugin's create(ctx) and validate what it returns. */
  async function instantiate() {
    const vis = await /** @type {import("./tidalviz").CreateVisualizer} */ (create)(
      /** @type {VisualizerContext} */ (ctx),
    );
    if (!isObject(vis) || typeof vis.frame !== "function") {
      throw new Error("create(ctx) must return an object with a frame(audio, time) function");
    }
    plugin = vis;
    if (dead) release(); // disposed while create was pending

  }

  /**
   * Run an optional plugin hook; errors are reported non-fatally.
   * @param {() => void} fn
   */
  function guard(fn) {
    try {
      fn();
    } catch (err) {
      postError(err, false);
    }
  }

  /** Stop rendering and let the plugin free its resources. */
  function release() {
    stopLoop();
    const p = plugin;
    plugin = null;
    if (p?.dispose) guard(() => p.dispose?.());
  }

  function dispose() {
    dead = true;
    release();
  }

  /** WebGL context lost: dispose the instance; it is re-created on restore. */
  function contextLost() {
    if (dead || lost || !create) return;
    lost = true;
    release();
    port.postMessage({ type: "contextLost" });
  }

  /** WebGL context restored: re-run create with the same ctx. Never rejects. */
  async function contextRestored() {
    if (dead || !lost) return;
    lost = false;
    try {
      handles?.reset?.();
      await instantiate();
    } catch (err) {
      fail(err);
      return;
    }
    startLoop();
  }

  /** @param {unknown} data a port message (untrusted: validated field by field) */
  function handleMessage(data) {
    if (data instanceof ArrayBuffer) {
      let flags;
      try {
        flags = peekFlags(data);
      } catch {
        return;
      }
      if (flags & FLAG_ONSET && latchedOnset < 0) latchedOnset = new DataView(data).getUint32(8, true);
      pending = data;
      return;
    }
    if (!isObject(data)) return;
    switch (data.type) {
      case "params": {
        if (!isObject(data.changed)) return;
        const changed = sanitizeParams(data.changed);
        Object.assign(params, changed);
        const p = plugin;
        if (p?.params) guard(() => p.params?.(changed));
        return;
      }
      case "settings":
        applySettings(data);
        if (plugin) resize();
        return;
      case "visibility":
        if (typeof data.visible !== "boolean") return;
        visible = data.visible;
        if (visible) startLoop();
        else stopLoop();
        return;
      case "dispose":
        dispose();
        port.postMessage({ type: "disposed" });
        return;
    }
  }

  return {
    start,
    handleMessage,
    contextLost,
    contextRestored,
    /** Errors outside create/frame (window `error`, `unhandledrejection`). @param {unknown} err */
    reportError(err) {
      postError(err, false);
    },
    /**
     * The canvas's CSS size changed (ResizeObserver).
     * @param {number} width
     * @param {number} height
     */
    setCssSize(width, height) {
      cssWidth = width;
      cssHeight = height;
      if (plugin) resize();
    },
  };
}
