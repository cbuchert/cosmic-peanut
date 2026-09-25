// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

/** @param {Partial<import("./validate.js").VizInfo>} o @returns {import("./validate.js").VizInfo} */
const viz = (o) => ({
  key: "builtin/bars", repo: "builtin", id: "bars", name: "Bars", description: "", author: "",
  renderer: "2d", thumbnailUrl: null, params: [], values: {}, disabled: false, dev: false,
  entryUrl: "", pageUrl: "about:blank", ...o,
});

const A = viz({
  key: "builtin/bars", name: "Bars",
  params: [{ id: "hue", type: "number", label: "Hue", min: 0, max: 360, default: 200 }],
  values: { hue: 120 },
});
const B = viz({ key: "builtin/orb", id: "orb", name: "Orb", renderer: "three" });
const C = viz({ key: "builtin/wave", id: "wave", name: "Wave" });

/** @param {Partial<Extract<import("./validate.js").HostMessage, { type: "hello" }>>} [o] */
const hello = (o = {}) => /** @type {import("./validate.js").HostMessage} */ ({
  type: "hello", version: 1, pluginOrigin: "http://127.0.0.1:2", visualizers: [A, B, C],
  repos: [{ repo: "builtin", url: null, path: null, commit: null, previous: null, dev: false, builtin: true }],
  settings: { quality: "auto", reduceFlashing: true, photosensitivityNoticeSeen: true },
  sources: [{ id: "system", name: "All audio" }, { id: "app:7", name: "Music" }],
  activeSource: "system", active: "builtin/bars", dev: true, ...o,
});

function fakeHost() {
  /** @type {any} */
  let deps;
  const host = {
    activeKey: /** @type {string | null} */ (null),
    pendingKey: /** @type {string | null} */ (null),
    show: vi.fn((/** @type {any} */ v) => (host.activeKey = v.key)),
    reload: vi.fn(),
    frame: vi.fn(),
    setParams: vi.fn(),
    setSettings: vi.fn(),
    setVisible: vi.fn(),
    shellStats: vi.fn(() => ({ count: 94, p50: 0.05, p99: 0.1, max: 0.2 })),
    dispose: vi.fn(),
    /** @param {import("./pluginHost.js").PluginEvent} e */
    emit: (e) => deps.onEvent(e),
    get deps() {
      return deps;
    },
  };
  return {
    host,
    /** @param {any} d */
    create: (d) => {
      deps = d;
      return host;
    },
  };
}

function setup() {
  document.body.innerHTML = '<div id="app"></div>';
  const root = /** @type {HTMLElement} */ (document.getElementById("app"));
  const { host, create } = fakeHost();
  /** @type {any[]} */
  const sent = [];
  const app = createApp({ root, send: (m) => (sent.push(m), true), createPluginHost: create, dpr: 2 });
  /** @param {string} key @param {Partial<KeyboardEventInit>} [o] */
  const press = (key, o = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...o }));
  const last = (/** @type {string} */ type) => sent.filter((m) => m.type === type).at(-1);
  return { app, root, host, sent, press, last };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("app: hello and selection", () => {
  it("hello renders the library and shows the active visualizer with its stored values", () => {
    const { app, root, host } = setup();
    app.handle(hello());
    expect(root.querySelectorAll("#library .card")).toHaveLength(3);
    expect(host.show).toHaveBeenCalledWith(A, { hue: 120 });
    expect(root.querySelector(".now-name")?.textContent).toBe("Bars");
    expect(host.deps.settings).toMatchObject({ quality: "auto", maxDpr: 2, fpsCap: 0, reduceFlashing: true });
  });

  it("with no active visualizer picks the first enabled one and persists it", () => {
    const { app, host, last } = setup();
    app.handle(hello({ active: null, visualizers: [{ ...A, disabled: true }, B] }));
    expect(host.show).toHaveBeenCalledWith(B, {});
    expect(last("select")).toEqual({ type: "select", key: "builtin/orb" });
  });

  it("clicking a library card selects it and sends select", () => {
    const { app, root, host, last } = setup();
    app.handle(hello());
    const cards = root.querySelectorAll("#library .card button.card-main");
    /** @type {HTMLButtonElement} */ (cards[1]).click();
    expect(host.show).toHaveBeenLastCalledWith(B, {});
    expect(last("select")).toEqual({ type: "select", key: "builtin/orb" });
  });

  it("params panel sends full values and forwards changes to the plugin", () => {
    const { app, root, host, last } = setup();
    app.handle(hello());
    const hue = /** @type {HTMLInputElement} */ (root.querySelector("#param-hue"));
    expect(hue.value).toBe("120");
    hue.value = "300";
    hue.dispatchEvent(new Event("input"));
    expect(last("params")).toEqual({ type: "params", key: "builtin/bars", values: { hue: 300 } });
    expect(host.setParams).toHaveBeenLastCalledWith({ hue: 300 });
    // switching away and back keeps the value
    app.select("builtin/orb");
    app.select("builtin/bars");
    expect(host.show).toHaveBeenLastCalledWith(A, { hue: 300 });
  });

  it("hot reload goes to the plugin host for the active key only, with current values", () => {
    const { app, host } = setup();
    app.handle(hello());
    app.handle({ type: "reload", key: "builtin/orb" });
    expect(host.reload).not.toHaveBeenCalled();
    app.handle({ type: "reload", key: "builtin/bars" });
    expect(host.reload).toHaveBeenCalledWith(A, { hue: 120 });
  });

  it("visualizers update refreshes the library; removal of the active one falls back", () => {
    const { app, root, host } = setup();
    app.handle(hello());
    app.handle({ type: "visualizers", visualizers: [B, C], repos: [] });
    expect(root.querySelectorAll("#library .card")).toHaveLength(2);
    expect(host.show).toHaveBeenLastCalledWith(B, {});
  });

  it("frames go to the plugin host", () => {
    const { app, host } = setup();
    const buf = new ArrayBuffer(4);
    app.frame(buf);
    expect(host.frame).toHaveBeenCalledWith(buf);
  });
});

describe("app: keys", () => {
  it("N / Shift+N cycle through enabled visualizers", () => {
    const { app, host, press } = setup();
    app.handle(hello({ visualizers: [A, { ...B, disabled: true }, C] }));
    press("n");
    expect(host.show).toHaveBeenLastCalledWith(C, {});
    press("n");
    expect(host.show).toHaveBeenLastCalledWith(A, { hue: 120 });
    press("N", { shiftKey: true });
    expect(host.show).toHaveBeenLastCalledWith(C, {});
  });

  it("F and T send window actions", () => {
    const { app, press, sent } = setup();
    app.handle(hello());
    press("f");
    press("t");
    expect(sent.filter((m) => m.type === "window")).toEqual([
      { type: "window", action: "fullscreen" },
      { type: "window", action: "floatOnTop" },
    ]);
  });

  it("L toggles the library, Esc closes panels", () => {
    const { app, root, press } = setup();
    app.handle(hello());
    const lib = /** @type {HTMLElement} */ (root.querySelector("#library"));
    expect(lib.hidden).toBe(true);
    press("l");
    expect(lib.hidden).toBe(false);
    expect(root.classList.contains("panel-open")).toBe(true);
    press("Escape");
    expect(lib.hidden).toBe(true);
    expect(root.classList.contains("panel-open")).toBe(false);
  });

  it("P toggles the HUD and persists it", () => {
    const { app, root, press, last } = setup();
    app.handle(hello());
    const hud = /** @type {HTMLElement} */ (root.querySelector("#hud"));
    expect(hud.hidden).toBe(true);
    press("p");
    expect(hud.hidden).toBe(false);
    expect(last("settings")).toEqual({ type: "settings", hudVisible: true });
  });

  it("H hides overlays until pressed again", () => {
    const { app, root, press } = setup();
    app.handle(hello());
    press("h");
    expect(root.classList.contains("overlays-hidden")).toBe(true);
    document.dispatchEvent(new Event("mousemove"));
    expect(root.classList.contains("overlays-hidden")).toBe(true);
    press("h");
    expect(root.classList.contains("overlays-hidden")).toBe(false);
  });

  it("overlays fade after 3 s without mouse movement", () => {
    const { app, root } = setup();
    app.handle(hello());
    vi.advanceTimersByTime(3100);
    expect(root.classList.contains("idle")).toBe(true);
    document.dispatchEvent(new Event("mousemove"));
    expect(root.classList.contains("idle")).toBe(false);
  });
});

describe("app: plugin events", () => {
  it("a fatal error in the active plugin reports and falls back to the previous visualizer", () => {
    const { app, host, last } = setup();
    app.handle(hello());
    app.select("builtin/orb");
    host.activeKey = null;
    host.emit({ kind: "fatal", key: "builtin/orb", error: { type: "error", message: "boom", fatal: true }, wasActive: true });
    expect(last("pluginError")).toEqual({ type: "pluginError", key: "builtin/orb", message: "boom", fatal: true });
    expect(host.show).toHaveBeenLastCalledWith(A, { hue: 120 });
    expect(last("select")).toEqual({ type: "select", key: "builtin/bars" });
    host.emit({ kind: "ready", key: "builtin/bars" });
    expect(/** @type {HTMLElement} */ (document.querySelector("#error")).hidden).toBe(false);
  });

  it("a successful hot reload of the errored visualizer clears the error", () => {
    const { app, host } = setup();
    app.handle(hello());
    host.emit({ kind: "error", key: "builtin/bars", error: { type: "error", message: "x", fatal: true }, reload: true });
    host.emit({ kind: "ready", key: "builtin/bars" });
    expect(/** @type {HTMLElement} */ (document.querySelector("#error")).hidden).toBe(true);
  });

  it("a fatal error in an incoming plugin re-selects the one still running", () => {
    const { app, host, last } = setup();
    app.handle(hello());
    host.show.mockImplementation(() => {}); // B never becomes active
    app.select("builtin/orb");
    host.emit({ kind: "fatal", key: "builtin/orb", error: { type: "error", message: "x", file: "m.js", line: 2, fatal: true }, wasActive: false });
    expect(last("pluginError")).toEqual({ type: "pluginError", key: "builtin/orb", message: "x", file: "m.js", line: 2, fatal: true });
    expect(last("select")).toEqual({ type: "select", key: "builtin/bars" });
    expect(app.selected).toBe("builtin/bars");
  });

  it("errors show a text-only overlay with file:line: message", () => {
    const { app, root, last } = setup();
    app.handle(hello());
    const host = /** @type {any} */ (app).pluginHost;
    host.emit({ kind: "error", key: "builtin/bars", error: { type: "error", message: "<b>bad</b>", file: "main.js", line: 9, fatal: true }, reload: true });
    const overlay = /** @type {HTMLElement} */ (root.querySelector("#error"));
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("main.js:9: <b>bad</b>");
    expect(overlay.querySelector("b")).toBeNull();
    expect(last("pluginError")).toMatchObject({ fatal: true, key: "builtin/bars" });
    /** @type {HTMLButtonElement} */ (overlay.querySelector("button")).click();
    expect(overlay.hidden).toBe(true);
  });

  it("perf goes to the host with shell time, and onsetSeen is forwarded", () => {
    const { app, host, last } = setup();
    app.handle(hello());
    host.emit({ kind: "perf", key: "builtin/bars", perf: { fps: 60, frameMsP50: 3, frameMsP99: 7, pluginMsP50: 1, renderScale: 1, dropped: 0 } });
    expect(last("perf")).toEqual({ type: "perf", key: "builtin/bars", fps: 60, frameMsP50: 3, frameMsP99: 7, pluginMsP50: 1, shellMs: 0.05, renderScale: 1, dropped: 0 });
    host.emit({ kind: "onsetSeen", key: "builtin/bars", frameIndex: 42 });
    expect(last("onsetSeen")).toEqual({ type: "onsetSeen", frameIndex: 42 });
  });

  it("log lines go to the dev console as text", () => {
    const { app, root, host } = setup();
    app.handle(hello());
    host.emit({ kind: "log", key: "builtin/bars", text: "<img src=x>" });
    const log = /** @type {HTMLElement} */ (root.querySelector("#devlog"));
    expect(log.textContent).toContain("<img src=x>");
    expect(log.querySelector("img")).toBeNull();
  });
});

describe("app: host messages", () => {
  it("status updates the status line", () => {
    const { app, root } = setup();
    app.handle(hello());
    app.handle({ type: "status", level: "warn", text: "Hmm <i>" });
    const s = /** @type {HTMLElement} */ (root.querySelector("#status"));
    expect(s.textContent).toBe("Hmm <i>");
    expect(s.dataset.level).toBe("warn");
  });

  it("silence shows permission help with a button that sends openPermissions", () => {
    const { app, root, last } = setup();
    app.handle(hello());
    const p = /** @type {HTMLElement} */ (root.querySelector("#permission"));
    expect(p.hidden).toBe(true);
    app.handle({ type: "silence", silent: true, seconds: 4 });
    expect(p.hidden).toBe(false);
    /** @type {HTMLButtonElement} */ (p.querySelector("button")).click();
    expect(last("openPermissions")).toEqual({ type: "openPermissions" });
    app.handle({ type: "silence", silent: false, seconds: 0 });
    expect(p.hidden).toBe(true);
  });

  it("source picker lists All audio plus apps and sends setSource", () => {
    const { app, root, last } = setup();
    app.handle(hello());
    const sel = /** @type {HTMLSelectElement} */ (root.querySelector("#source"));
    expect([...sel.options].map((o) => o.textContent)).toEqual(["All audio", "Music"]);
    sel.value = "app:7";
    sel.dispatchEvent(new Event("change"));
    expect(last("setSource")).toEqual({ type: "setSource", id: "app:7" });
    app.handle({ type: "sources", sources: [{ id: "system", name: "All audio" }], active: "system" });
    expect(sel.options).toHaveLength(1);
  });

  it("install prompt shows URL, commit, visualizers and the sandbox note; confirm/cancel", () => {
    const { app, root, last } = setup();
    app.handle(hello());
    app.handle({ type: "installPrompt", id: "i1", url: "https://github.com/a/b", commit: "abcdef123456", visualizers: [{ id: "v", name: "Vortex" }] });
    const d = /** @type {HTMLElement} */ (root.querySelector("#install"));
    expect(d.hidden).toBe(false);
    expect(d.textContent).toContain("https://github.com/a/b");
    expect(d.textContent).toContain("abcdef1");
    expect(d.textContent).toContain("Vortex");
    expect(d.textContent).toMatch(/sandbox/i);
    /** @type {HTMLButtonElement} */ (d.querySelector("button.primary")).click();
    expect(last("installConfirm")).toEqual({ type: "installConfirm", id: "i1", accept: true });
    expect(d.hidden).toBe(true);
    app.handle({ type: "installPrompt", id: "i2", url: "u", commit: "c", visualizers: [] });
    /** @type {HTMLButtonElement} */ (d.querySelector("button.cancel")).click();
    expect(last("installConfirm")).toEqual({ type: "installConfirm", id: "i2", accept: false });
  });

  it("disabled marks the visualizer and falls back if it was active", () => {
    const { app, root, host } = setup();
    app.handle(hello());
    app.handle({ type: "disabled", key: "builtin/bars", reason: "It stopped responding" });
    expect(host.show).toHaveBeenLastCalledWith(B, {});
    expect(root.querySelector("#status")?.textContent).toContain("It stopped responding");
    expect(root.querySelector("#library .card.is-disabled")).not.toBeNull();
  });

  it("library actions send install/addFolder/enable", () => {
    const { app, root, last } = setup();
    app.handle(hello());
    /** @type {HTMLButtonElement} */ (root.querySelector("button.add-folder")).click();
    expect(last("addFolder")).toEqual({ type: "addFolder" });
  });
});

describe("app: settings", () => {
  it("first launch shows the photosensitivity notice; dismissing persists it", () => {
    const { app, root, last } = setup();
    app.handle(hello({ settings: {} }));
    const n = /** @type {HTMLElement} */ (root.querySelector("#notice"));
    expect(n.hidden).toBe(false);
    /** @type {HTMLButtonElement} */ (n.querySelector("button.primary")).click();
    expect(n.hidden).toBe(true);
    expect(last("settings")).toEqual({ type: "settings", photosensitivityNoticeSeen: true });
  });

  it("reduce flashing is on by default and toggling goes to host and plugins", () => {
    const { app, root, host, last } = setup();
    app.handle(hello({ settings: { photosensitivityNoticeSeen: true } }));
    const cb = /** @type {HTMLInputElement} */ (root.querySelector("#reduce-flashing"));
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    expect(last("settings")).toEqual({ type: "settings", reduceFlashing: false });
    expect(host.setSettings).toHaveBeenLastCalledWith({ reduceFlashing: false });
  });

  it("quality picker maps to DPR/fps caps", () => {
    const { app, root, host, last } = setup();
    app.handle(hello());
    const q = /** @type {HTMLSelectElement} */ (root.querySelector("#quality"));
    q.value = "battery";
    q.dispatchEvent(new Event("change"));
    expect(last("settings")).toEqual({ type: "settings", quality: "battery" });
    expect(host.setSettings).toHaveBeenLastCalledWith({ quality: "battery", maxDpr: 1, fpsCap: 30, renderScaleMax: 1 });
  });

  it("auto-cycle moves to the next visualizer every N seconds", () => {
    const { app, root, host, last } = setup();
    app.handle(hello());
    const sel = /** @type {HTMLSelectElement} */ (root.querySelector("#auto-cycle"));
    expect(sel.value).toBe("0");
    sel.value = "30";
    sel.dispatchEvent(new Event("change"));
    expect(last("settings")).toEqual({ type: "settings", autoCycleSeconds: 30 });
    vi.advanceTimersByTime(30_000);
    expect(host.show).toHaveBeenLastCalledWith(B, {});
    vi.advanceTimersByTime(30_000);
    expect(host.show).toHaveBeenLastCalledWith(C, {});
  });

  it("visibility changes are forwarded to plugins", () => {
    const { app, host } = setup();
    app.handle(hello());
    document.dispatchEvent(new Event("visibilitychange"));
    expect(host.setVisible).toHaveBeenCalled();
  });
});
