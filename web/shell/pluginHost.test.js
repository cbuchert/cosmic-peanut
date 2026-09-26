// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginHost, formatError } from "./pluginHost.js";

class FakePort {
  /** @type {{ msg: unknown; transfer?: Transferable[] }[]} */
  posted = [];
  /** @type {((ev: { data: unknown }) => void) | null} */
  onmessage = null;
  closed = false;
  /** @param {unknown} msg @param {Transferable[]} [transfer] */
  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer: transfer ? [...transfer] : undefined });
    if (transfer) for (const t of transfer) if (t instanceof ArrayBuffer) structuredClone(t, { transfer: [t] });
  }
  start() {}
  close() {
    this.closed = true;
  }
  /** @param {unknown} data */
  emit(data) {
    this.onmessage?.({ data });
  }
}

/** @typedef {{ iframe: HTMLIFrameElement; win: { postMessage: ReturnType<typeof vi.fn> }; port1: FakePort; port2: FakePort }} Made */

function setup() {
  document.body.innerHTML = '<div id="stage"></div>';
  const container = /** @type {HTMLElement} */ (document.getElementById("stage"));
  /** @type {Made[]} */
  const made = [];
  /** @type {FakePort[][]} */
  const channels = [];
  const events = /** @type {any[]} */ ([]);
  const host = createPluginHost({
    container,
    createFrame() {
      const iframe = document.createElement("iframe");
      const win = { postMessage: vi.fn() };
      Object.defineProperty(iframe, "contentWindow", { get: () => win });
      made.push(/** @type {Made} */ ({ iframe, win }));
      return iframe;
    },
    createChannel() {
      const pair = [new FakePort(), new FakePort()];
      channels.push(pair);
      return /** @type {any} */ ({ port1: pair[0], port2: pair[1] });
    },
    onEvent: (e) => events.push(e),
    settings: { quality: "auto", maxDpr: 2, fpsCap: 0, renderScaleMax: 1, reduceFlashing: true },
    visible: () => true,
  });
  /** load iframe i and return its shell-side port */
  const load = (/** @type {number} */ i) => {
    made[i].iframe.dispatchEvent(new Event("load"));
    const port = channels[channels.length - 1][0];
    made[i].port1 = port;
    made[i].port2 = channels[channels.length - 1][1];
    return port;
  };
  return { host, container, made, events, load };
}

const vizA = { key: "r/a", name: "A", pageUrl: "about:blank#a" };
const vizB = { key: "r/b", name: "B", pageUrl: "about:blank#b" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pluginHost", () => {
  it("creates a sandboxed iframe with only allow-scripts", () => {
    const { host, container, made } = setup();
    host.show(vizA, { hue: 1 });
    expect(made).toHaveLength(1);
    const f = made[0].iframe;
    expect(container.contains(f)).toBe(true);
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("src")).toBe("about:blank#a");
    expect(f.hasAttribute("allow")).toBe(false);
    expect(f.tabIndex).toBe(-1);
  });

  it("on load posts tidalviz:init with the port via contentWindow.postMessage", () => {
    const { host, made, load } = setup();
    host.show(vizA, { hue: 1 });
    load(0);
    expect(made[0].win.postMessage).toHaveBeenCalledTimes(1);
    const [msg, origin, transfer] = made[0].win.postMessage.mock.calls[0];
    expect(msg).toEqual({
      type: "tidalviz:init",
      params: { hue: 1 },
      quality: "auto",
      renderScaleMax: 1,
      maxDpr: 2,
      fpsCap: 0,
      reduceFlashing: true,
      visible: true,
    });
    expect(origin).toBe("*");
    expect(transfer).toEqual([made[0].port2]);
    // A second load (plugin navigated its own frame) does not re-init.
    made[0].iframe.dispatchEvent(new Event("load"));
    expect(made[0].win.postMessage).toHaveBeenCalledTimes(1);
  });

  it("transfers frames to the active iframe without keeping them", () => {
    const { host, load } = setup();
    host.show(vizA, {});
    const port = load(0);
    const buf = new ArrayBuffer(16);
    host.frame(buf);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0].msg).toBe(buf);
    expect(port.posted[0].transfer).toEqual([buf]);
    expect(buf.byteLength).toBe(0); // detached
  });

  it("validates port messages and reports ready, perf, onsetSeen, log, contextLost", () => {
    const { host, events, load } = setup();
    host.show(vizA, {});
    const port = load(0);
    port.emit({ type: "ready" });
    port.emit({ type: "perf", fps: 60, frameMsP50: 2, frameMsP99: 5, pluginMsP50: 1, renderScale: 1, dropped: 0 });
    port.emit({ type: "onsetSeen", frameIndex: 7 });
    port.emit({ type: "log", text: "<b>hi</b>" });
    port.emit({ type: "contextLost" });
    port.emit({ type: "perf", fps: "fast" });
    port.emit(new ArrayBuffer(3));
    expect(events.map((e) => e.kind)).toEqual(["ready", "perf", "onsetSeen", "log", "contextLost"]);
    expect(events[1].perf.fps).toBe(60);
    expect(events[2]).toEqual({ kind: "onsetSeen", key: "r/a", frameIndex: 7 });
    expect(events[3].text).toBe("<b>hi</b>");
  });

  it("crossfades: the incoming iframe gets copies, then becomes active after ready", () => {
    const { host, made, events, load } = setup();
    host.show(vizA, {});
    const pa = load(0);
    pa.emit({ type: "ready" });
    host.show(vizB, {});
    expect(made).toHaveLength(2);
    expect(made[1].iframe.style.opacity).toBe("0");
    const pb = load(1);
    const buf = new ArrayBuffer(8);
    host.frame(buf);
    expect(pb.posted[pb.posted.length - 1].transfer).toBeUndefined();
    expect(/** @type {ArrayBuffer} */ (pb.posted[pb.posted.length - 1].msg).byteLength).toBe(8);
    expect(pa.posted[pa.posted.length - 1].msg).toBe(buf);
    pb.emit({ type: "ready" });
    expect(host.activeKey).toBe("r/b");
    expect(made[1].iframe.style.opacity).toBe("1");
    expect(made[0].iframe.style.opacity).toBe("0");
    // during the fade both render; new one is transferred, old one gets a copy
    const buf2 = new ArrayBuffer(8);
    host.frame(buf2);
    expect(pb.posted[pb.posted.length - 1].msg).toBe(buf2);
    expect(/** @type {ArrayBuffer} */ (pa.posted[pa.posted.length - 1].msg).byteLength).toBe(8);
    vi.advanceTimersByTime(1500);
    expect(pa.posted.some((p) => /** @type {any} */ (p.msg).type === "dispose")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(made[0].iframe.isConnected).toBe(false);
    expect(events.filter((e) => e.kind === "ready").map((e) => e.key)).toEqual(["r/a", "r/b"]);
  });

  it("a fatal error in the settled active plugin unloads it and reports fatal", () => {
    const { host, made, events, load } = setup();
    host.show(vizA, {});
    const pa = load(0);
    pa.emit({ type: "ready" });
    pa.emit({ type: "error", message: "boom", file: "main.js", line: 3, fatal: true });
    expect(host.activeKey).toBe(null);
    expect(events[events.length - 1]).toEqual({
      kind: "fatal",
      key: "r/a",
      error: { type: "error", message: "boom", file: "main.js", line: 3, fatal: true },
      wasActive: true,
    });
    vi.advanceTimersByTime(200);
    expect(made[0].iframe.isConnected).toBe(false);
  });

  it("a fatal error in an incoming plugin keeps the current one", () => {
    const { host, made, events, load } = setup();
    host.show(vizA, {});
    load(0).emit({ type: "ready" });
    host.show(vizB, {});
    load(1).emit({ type: "error", message: "nope", fatal: true });
    expect(host.activeKey).toBe("r/a");
    expect(events[events.length - 1].kind).toBe("fatal");
    expect(events[events.length - 1].wasActive).toBe(false);
    vi.advanceTimersByTime(200);
    expect(made[1].iframe.isConnected).toBe(false);
    expect(made[0].iframe.isConnected).toBe(true);
  });

  it("non-fatal errors are reported without unloading", () => {
    const { host, events, load } = setup();
    host.show(vizA, {});
    const pa = load(0);
    pa.emit({ type: "ready" });
    pa.emit({ type: "error", message: "meh", fatal: false });
    expect(host.activeKey).toBe("r/a");
    expect(events[events.length - 1]).toMatchObject({ kind: "error", key: "r/a", reload: false });
  });

  it("an incoming plugin that never becomes ready is treated as fatal", () => {
    const { host, events, load } = setup();
    host.show(vizA, {});
    load(0).emit({ type: "ready" });
    host.show(vizB, {});
    load(1);
    vi.advanceTimersByTime(10_000);
    expect(host.activeKey).toBe("r/a");
    expect(events[events.length - 1]).toMatchObject({ kind: "fatal", key: "r/b", wasActive: false });
  });

  it("hot reload loads hidden, swaps instantly on ready, and keeps params", () => {
    const { host, made, load } = setup();
    host.show(vizA, { hue: 1 });
    const pa = load(0);
    pa.emit({ type: "ready" });
    host.reload(vizA, { hue: 9 });
    expect(made).toHaveLength(2);
    expect(made[1].iframe.style.opacity).toBe("0");
    const pa2 = load(1);
    expect(made[1].win.postMessage.mock.calls[0][0].params).toEqual({ hue: 9 });
    pa2.emit({ type: "ready" });
    expect(made[1].iframe.style.opacity).toBe("1");
    expect(made[1].iframe.classList.contains("instant")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(made[0].iframe.isConnected).toBe(false);
  });

  it("hot reload errors keep the old plugin running and report reload errors", () => {
    const { host, made, events, load } = setup();
    host.show(vizA, {});
    load(0).emit({ type: "ready" });
    host.reload(vizA, {});
    load(1).emit({ type: "error", message: "SyntaxError", file: "main.js", line: 4, fatal: true });
    expect(host.activeKey).toBe("r/a");
    expect(events[events.length - 1]).toMatchObject({ kind: "error", key: "r/a", reload: true });
    vi.advanceTimersByTime(200);
    expect(made[1].iframe.isConnected).toBe(false);
    expect(made[0].iframe.isConnected).toBe(true);
  });

  it("reload for a key that is not active is ignored", () => {
    const { host, made, load } = setup();
    host.show(vizA, {});
    load(0).emit({ type: "ready" });
    host.reload(vizB, {});
    expect(made).toHaveLength(1);
  });

  it("forwards params, settings and visibility to all live iframes", () => {
    const { host, load } = setup();
    host.show(vizA, {});
    const pa = load(0);
    host.setParams({ hue: 3 });
    host.setSettings({ reduceFlashing: false, fpsCap: 30 });
    host.setVisible(false);
    expect(pa.posted.map((p) => p.msg)).toEqual([
      { type: "params", changed: { hue: 3 } },
      { type: "settings", reduceFlashing: false, fpsCap: 30 },
      { type: "visibility", visible: false },
    ]);
  });

  it("lets clicks reach a throttled plugin iframe until it runs at display rate", () => {
    const { host, load, made } = setup();
    host.show(vizA, {});
    const pa = load(0);
    pa.emit({ type: "ready" });
    const perf = (/** @type {number} */ fps) =>
      pa.emit({ type: "perf", fps, frameMsP50: 2, frameMsP99: 5, pluginMsP50: 1, renderScale: 1, dropped: 0 });
    expect(made[0].iframe.style.pointerEvents).toBe("");
    perf(21); // WebKit's never-clicked cross-origin iframe rate
    expect(made[0].iframe.style.pointerEvents).toBe("auto");
    perf(60);
    expect(made[0].iframe.style.pointerEvents).toBe("");
  });

  it("forwards pointer input to the active plugin only", () => {
    const { host, load } = setup();
    host.show(vizA, {});
    const pa = load(0);
    pa.emit({ type: "ready" });
    host.pointer("down", 10, 20, 0, 0);
    host.pointer("move", 14, 19, 4, -1);
    expect(pa.posted.map((p) => p.msg)).toEqual([
      { type: "pointer", kind: "down", x: 10, y: 20, dx: 0, dy: 0 },
      { type: "pointer", kind: "move", x: 14, y: 19, dx: 4, dy: -1 },
    ]);
  });

  it("measures shell time per frame", () => {
    const { host, load } = setup();
    host.show(vizA, {});
    load(0);
    for (let i = 0; i < 10; i++) host.frame(new ArrayBuffer(8));
    const s = host.shellStats();
    expect(s.count).toBe(10);
    expect(s.p50).toBeGreaterThanOrEqual(0);
    expect(s.max).toBeGreaterThanOrEqual(s.p50);
  });
});

describe("formatError", () => {
  it("formats file:line: message", () => {
    expect(formatError({ message: "m", file: "a.js", line: 2 })).toBe("a.js:2: m");
    expect(formatError({ message: "m", file: "a.js" })).toBe("a.js: m");
    expect(formatError({ message: "m" })).toBe("m");
  });
});
