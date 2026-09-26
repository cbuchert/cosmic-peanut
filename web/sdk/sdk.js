// @ts-check
/**
 * Tidalviz plugin SDK entry point. The host's bootstrap page (docs/protocols.md §3) does:
 *
 *   import { boot } from "/sdk/sdk.js";
 *   boot({ key, entry, base, manifest });
 *
 * boot waits for exactly one `tidalviz:init` message from window.parent carrying a MessagePort,
 * creates the full-window canvas and the renderer context, loads the plugin entry and runs it.
 * All the logic lives in runtime.js; this file only wires it to the browser.
 */

import { createRuntime } from "./runtime.js";
import { createRendererContext } from "./renderer.js";

/**
 * @typedef {{ key: string, entry: string, base: string,
 *   manifest: import("./tidalviz").VisualizerManifestEntry }} BootOptions
 * @typedef {{ importModule?: (specifier: string) => Promise<any> }} BootEnv
 */

/** @param {string} specifier */
const importModule = (specifier) => import(/* @vite-ignore */ specifier);

/**
 * @param {BootOptions} opts
 * @param {BootEnv} [env] test seam; production uses the real `import()`
 * @returns {Promise<ReturnType<typeof createRuntime>>} resolves once the plugin is running (or failed fatally)
 */
export function boot(opts, env = {}) {
  const load = env.importModule ?? importModule;
  return new Promise((resolve) => {
    /** @param {MessageEvent} e */
    const onMessage = (e) => {
      if (e.source !== window.parent) return;
      const d = e.data;
      if (typeof d !== "object" || d === null || d.type !== "tidalviz:init") return;
      const port = e.ports?.[0];
      if (!port) return;
      window.removeEventListener("message", onMessage);
      resolve(start(opts, d, port, load));
    };
    window.addEventListener("message", onMessage);
  });
}

/**
 * @param {BootOptions} opts
 * @param {Record<string, unknown>} init
 * @param {MessagePort} port
 * @param {(specifier: string) => Promise<any>} load
 */
async function start(opts, init, port, load) {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const cssSize = {
    width: canvas.clientWidth || window.innerWidth,
    height: canvas.clientHeight || window.innerHeight,
  };
  const rt = createRuntime({
    port,
    init,
    manifest: opts.manifest,
    base: new URL(opts.base, location.href).href,
    canvas,
    cssSize,
    loadEntry: () => load(new URL(opts.entry, location.href).href),
    createContext: (kind, c) =>
      createRendererContext(kind, c, {
        gpu: navigator.gpu,
        importThree: () => load("three"),
        fallback: opts.manifest.fallback,
      }),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    now: () => performance.now(),
    devicePixelRatio: () => window.devicePixelRatio || 1,
    fetch: (url) => fetch(url),
    createImageBitmap: (b) => createImageBitmap(b),
    reduceMotion: (() => {
      const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
      return () => mq?.matches ?? false;
    })(),
  });

  port.onmessage = (e) => rt.handleMessage(e.data); // setting onmessage also starts the port

  window.addEventListener("error", (e) => rt.reportError(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => rt.reportError(e.reason));

  // WebGL context loss (webgl2 and three). preventDefault lets the browser restore the context.
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    rt.contextLost();
  });
  canvas.addEventListener("webglcontextrestored", () => void rt.contextRestored());

  if (typeof ResizeObserver === "function") {
    new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      rt.setCssSize(r.width, r.height);
    }).observe(canvas);
  } else {
    window.addEventListener("resize", () => rt.setCssSize(canvas.clientWidth, canvas.clientHeight));
  }

  await rt.start();
  return rt;
}
