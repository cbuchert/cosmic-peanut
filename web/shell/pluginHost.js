// PluginHost: owns the sandboxed visualizer iframes (docs/protocols.md §5).
//
// At most three iframes live at once: `active` (receives frames by transfer), `incoming` (a
// switch or hot reload loading behind it) and `fading` (the previous one during a crossfade).
// Non-active iframes receive a copy of each frame. `frame()` is the hot path: no allocation
// besides the copies the protocol requires, no DOM access.

import { parsePluginMessage } from "./validate.js";

/**
 * @typedef {import("./validate.js").ParamValues} ParamValues
 * @typedef {import("./validate.js").PluginPerf} PluginPerf
 * @typedef {{ type: "error"; message: string; file?: string; line?: number; fatal: boolean }} PluginError
 * @typedef {{ key: string; name?: string; pageUrl: string }} VizRef
 * @typedef {{ quality: import("./validate.js").QualityMode; maxDpr: number; fpsCap: number;
 *   renderScaleMax: number; reduceFlashing: boolean }} RenderSettings
 * @typedef {{ kind: "ready"; key: string }
 *   | { kind: "error"; key: string; error: PluginError; reload: boolean }
 *   | { kind: "fatal"; key: string; error: PluginError; wasActive: boolean }
 *   | { kind: "perf"; key: string; perf: PluginPerf }
 *   | { kind: "onsetSeen"; key: string; frameIndex: number }
 *   | { kind: "log"; key: string; text: string }
 *   | { kind: "contextLost"; key: string }} PluginEvent
 * @typedef {{ viz: VizRef; iframe: HTMLIFrameElement; port: MessagePort | null; ready: boolean;
 *   mode: "initial" | "switch" | "reload"; params: ParamValues; gone: boolean;
 *   timer: ReturnType<typeof setTimeout> | undefined }} Slot
 *
 * @typedef {object} PluginHostDeps
 * @property {HTMLElement} container
 * @property {RenderSettings} settings
 * @property {(e: PluginEvent) => void} onEvent
 * @property {() => boolean} visible
 * @property {() => HTMLIFrameElement} [createFrame]
 * @property {() => MessageChannel} [createChannel]
 * @property {() => number} [now]
 * @property {number} [crossfadeMs]
 * @property {number} [readyTimeoutMs]
 */

export const CROSSFADE_MS = 1500;
const READY_TIMEOUT_MS = 10_000;
const REMOVE_DELAY_MS = 100; // let the SDK run dispose() before the iframe goes away
const RING = 512;
const THROTTLED_FPS = 40;

/** @param {{ message: string; file?: string; line?: number }} e */
export function formatError(e) {
  if (!e.file) return e.message;
  return e.line !== undefined ? `${e.file}:${e.line}: ${e.message}` : `${e.file}: ${e.message}`;
}

/** @param {PluginHostDeps} deps */
export function createPluginHost(deps) {
  const { container, onEvent } = deps;
  const doc = container.ownerDocument;
  const createFrame = deps.createFrame ?? (() => doc.createElement("iframe"));
  const createChannel = deps.createChannel ?? (() => new MessageChannel());
  const now = deps.now ?? (() => performance.now());
  const crossfadeMs = deps.crossfadeMs ?? CROSSFADE_MS;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  /** @type {RenderSettings} */
  const settings = { ...deps.settings };

  /** @type {Slot | null} */ let active = null;
  /** @type {Slot | null} */ let incoming = null;
  /** @type {Slot | null} */ let fading = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let fadeTimer;
  /** Non-active slots, rebuilt on state change so `frame()` never allocates. @type {Slot[]} */
  let others = [];
  /** Reused transfer list. @type {any[]} */
  const xfer = [null];

  const ring = new Float64Array(RING);
  const scratch = new Float64Array(RING);
  let ringIdx = 0;
  let ringCount = 0;

  function refresh() {
    others = [];
    if (incoming) others.push(incoming);
    if (fading) others.push(fading);
  }

  function live() {
    /** @type {Slot[]} */
    const out = [];
    for (const s of [active, incoming, fading]) if (s && s.port) out.push(s);
    return out;
  }

  /** @param {Slot} slot @param {unknown} msg */
  function post(slot, msg) {
    slot.port?.postMessage(msg);
  }

  /** @param {VizRef} viz @param {ParamValues} params @param {Slot["mode"]} mode */
  function create(viz, params, mode) {
    const iframe = createFrame();
    iframe.className = "viz-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.tabIndex = -1;
    iframe.title = viz.name ? `Visualizer: ${viz.name}` : "Visualizer";
    iframe.style.opacity = mode === "initial" ? "1" : "0";
    if (mode === "reload") iframe.classList.add("instant");
    /** @type {Slot} */
    const slot = { viz, iframe, port: null, ready: false, mode, params: { ...params }, gone: false, timer: undefined };
    iframe.addEventListener("load", () => {
      if (slot.port || slot.gone) return; // only the first load gets a port
      const ch = createChannel();
      slot.port = ch.port1;
      ch.port1.onmessage = (ev) => onMessage(slot, ev.data);
      const init = {
        type: "tidalviz:init",
        params: slot.params,
        quality: settings.quality,
        renderScaleMax: settings.renderScaleMax,
        maxDpr: settings.maxDpr,
        fpsCap: settings.fpsCap,
        reduceFlashing: settings.reduceFlashing,
        visible: deps.visible(),
      };
      iframe.contentWindow?.postMessage(init, "*", [ch.port2]);
    });
    slot.timer = setTimeout(() => {
      if (!slot.ready && !slot.gone) {
        onError(slot, { type: "error", message: "Visualizer did not start within 10 s", fatal: true });
      }
    }, readyTimeoutMs);
    iframe.setAttribute("src", viz.pageUrl);
    container.append(iframe);
    return slot;
  }

  /** @param {Slot} slot */
  function drop(slot) {
    if (slot.gone) return;
    slot.gone = true;
    clearTimeout(slot.timer);
    slot.iframe.style.visibility = "hidden";
    const port = slot.port;
    if (port) {
      port.onmessage = null;
      port.postMessage({ type: "dispose" });
    }
    setTimeout(() => {
      port?.close();
      slot.iframe.remove();
    }, REMOVE_DELAY_MS);
  }

  /** @param {Slot} slot */
  function onReady(slot) {
    slot.ready = true;
    clearTimeout(slot.timer);
    onEvent({ kind: "ready", key: slot.viz.key });
    if (slot !== incoming) return;
    incoming = null;
    const old = active;
    active = slot;
    slot.iframe.style.opacity = "1";
    if (slot.mode === "reload" || !old) {
      if (old) drop(old);
    } else {
      if (fading) drop(fading);
      clearTimeout(fadeTimer);
      fading = old;
      old.iframe.style.opacity = "0";
      fadeTimer = setTimeout(() => {
        if (fading) drop(fading);
        fading = null;
        refresh();
      }, crossfadeMs);
    }
    refresh();
  }

  /** @param {Slot} slot @param {PluginError} error */
  function onError(slot, error) {
    const key = slot.viz.key;
    if (slot.mode === "reload" && slot === incoming) {
      if (error.fatal) {
        drop(slot);
        incoming = null;
        refresh();
      }
      onEvent({ kind: "error", key, error, reload: true });
      return;
    }
    if (!error.fatal) {
      onEvent({ kind: "error", key, error, reload: false });
      return;
    }
    drop(slot);
    if (slot === incoming) {
      incoming = null;
      refresh();
      onEvent({ kind: "fatal", key, error, wasActive: false });
    } else if (slot === active) {
      active = null;
      onEvent({ kind: "fatal", key, error, wasActive: true });
    } else if (slot === fading) {
      fading = null;
      refresh();
    }
  }

  /** @param {Slot} slot @param {unknown} data */
  function onMessage(slot, data) {
    if (slot.gone) return;
    const m = parsePluginMessage(data);
    if (!m) return;
    const key = slot.viz.key;
    switch (m.type) {
      case "ready":
        if (!slot.ready) onReady(slot);
        break;
      case "error":
        onError(slot, m);
        break;
      case "perf": {
        const { type: _t, ...perf } = m;
        // WebKit runs a cross-origin iframe's rAF at 20 Hz until a click lands *inside* it
        // (tools/spike/REPORT.md). The iframe normally ignores the pointer so the shell sees
        // the mouse; while it's throttled, let the next click (the host's native one, or the
        // user's) through, then take the pointer back.
        if (slot === active) slot.iframe.style.pointerEvents = m.fps > 0 && m.fps < THROTTLED_FPS ? "auto" : "";
        onEvent({ kind: "perf", key, perf });
        break;
      }
      case "onsetSeen":
        onEvent({ kind: "onsetSeen", key, frameIndex: m.frameIndex });
        break;
      case "log":
        onEvent({ kind: "log", key, text: m.text });
        break;
      case "contextLost":
        onEvent({ kind: "contextLost", key });
        break;
    }
  }

  return {
    get activeKey() {
      return active ? active.viz.key : null;
    },
    get pendingKey() {
      return incoming ? incoming.viz.key : null;
    },

    /** Switch to `viz` (crossfade once it is ready), or show it directly if nothing is active.
     * @param {VizRef} viz @param {ParamValues} params */
    show(viz, params) {
      if (incoming) {
        drop(incoming);
        incoming = null;
      }
      const slot = create(viz, params, active ? "switch" : "initial");
      if (active) incoming = slot;
      else active = slot;
      refresh();
    },

    /** Hot reload: load hidden, swap on ready; errors leave the current one running.
     * @param {VizRef} viz @param {ParamValues} params */
    reload(viz, params) {
      if (!active || active.viz.key !== viz.key) return;
      if (incoming) drop(incoming);
      incoming = create(viz, params, "reload");
      refresh();
    },

    /** Hot path. @param {ArrayBuffer} buf */
    frame(buf) {
      const t0 = now();
      for (let i = 0; i < others.length; i++) {
        const p = others[i].port;
        if (p) p.postMessage(buf.slice(0));
      }
      const a = active;
      if (a && a.port) {
        xfer[0] = buf;
        a.port.postMessage(buf, xfer);
        xfer[0] = null;
      }
      ring[ringIdx] = now() - t0;
      ringIdx = (ringIdx + 1) % RING;
      if (ringCount < RING) ringCount++;
    },

    /** Shell time per frame since the last call (ms). Resets the window. */
    shellStats() {
      const n = ringCount;
      if (n === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
      const view = scratch.subarray(0, n);
      for (let i = 0; i < n; i++) view[i] = ring[(ringIdx - n + i + RING) % RING];
      view.sort();
      ringCount = 0;
      return { count: n, p50: view[n >> 1], p99: view[Math.min(n - 1, Math.floor(n * 0.99))], max: view[n - 1] };
    },

    /** @param {ParamValues} changed */
    setParams(changed) {
      for (const s of live()) post(s, { type: "params", changed });
      if (incoming) Object.assign(incoming.params, changed);
    },

    /** @param {Partial<RenderSettings>} partial */
    setSettings(partial) {
      Object.assign(settings, partial);
      for (const s of live()) post(s, { type: "settings", ...partial });
    },

    /**
     * Pointer input on the stage, for the active plugin only (iframes don't get pointer
     * events themselves, so the shell keeps its idle/overlay handling).
     * @param {"down" | "move" | "up"} kind @param {number} x @param {number} y
     * @param {number} dx @param {number} dy
     */
    pointer(kind, x, y, dx, dy) {
      if (active?.port) post(active, { type: "pointer", kind, x, y, dx, dy });
    },

    /** @param {boolean} visible */
    setVisible(visible) {
      for (const s of live()) post(s, { type: "visibility", visible });
    },

    /** Unload everything. */
    dispose() {
      for (const s of [active, incoming, fading]) if (s) drop(s);
      active = incoming = fading = null;
      refresh();
    },
  };
}
