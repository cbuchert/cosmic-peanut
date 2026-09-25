import { describe, it, expect, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import { encodeFrame } from "./dev/encode.js";

const BASE = "http://127.0.0.1:5000/r/abc/";

/**
 * Build a runtime around fakes. `plugin` is what create() returns (or a function of ctx).
 * @param {{ plugin?: any, create?: (ctx: any) => any, init?: any, manifest?: any, contexts?: any, dpr?: number,
 *   createContext?: any }} [o]
 */
function harness(o = {}) {
  /** @type {any[]} */
  const posted = [];
  const port = { postMessage: (/** @type {any} */ m) => posted.push(m) };
  /** @type {Map<number, (ts: number) => void>} */
  const callbacks = new Map();
  let nextId = 1;
  const clock = { t: 0 };
  const plugin = o.plugin ?? { frame: vi.fn() };
  const create = vi.fn(o.create ?? (() => plugin));
  const canvas = { width: 0, height: 0 };
  const rt = createRuntime({
    port,
    init: { type: "tidalviz:init", params: {}, quality: "auto", renderScaleMax: 1, maxDpr: null, fpsCap: null, reduceFlashing: true, visible: true, ...o.init },
    manifest: { id: "pulse", name: "Pulse", entry: "src/main.js", renderer: "2d", ...o.manifest },
    base: BASE,
    canvas: /** @type {any} */ (canvas),
    cssSize: { width: 800, height: 600 },
    loadEntry: async () => ({ default: create }),
    createContext: o.createContext ?? (async () => ({ ctx2d: /** @type {any} */ ({ fake2d: true }), gl: null, gpu: null, three: null, ...o.contexts })),
    raf: (/** @type {(ts: number) => void} */ cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    caf: (/** @type {number} */ id) => void callbacks.delete(id),
    now: () => clock.t,
    devicePixelRatio: () => o.dpr ?? 2,
    fetch: async () => new Response(""),
  });
  /** Advance the fake clock to `ms` and run pending rAF callbacks with timestamp `ms`. */
  const tick = (/** @type {number} */ ms) => {
    clock.t = ms;
    const cbs = [...callbacks.values()];
    callbacks.clear();
    for (const cb of cbs) cb(ms);
  };
  const types = () => posted.map((m) => (m instanceof Object && "type" in m ? m.type : m));
  return { rt, posted, types, tick, plugin, create, canvas, clock, pendingRaf: () => callbacks.size };
}

describe("runtime lifecycle", () => {
  it("calls create with a ctx per the d.ts and sizes the canvas first", async () => {
    const h = harness({ init: { params: { hue: 10 } } });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    expect(ctx.apiVersion).toBe(1);
    expect([ctx.id, ctx.name, ctx.renderer]).toEqual(["pulse", "Pulse", "2d"]);
    expect(ctx.canvas).toBe(h.canvas);
    expect(ctx.ctx2d).toEqual({ fake2d: true });
    expect([ctx.gl, ctx.gpu, ctx.three]).toEqual([null, null, null]);
    expect(ctx.params).toEqual({ hue: 10 });
    expect(ctx.size).toEqual({ width: 1600, height: 1200, cssWidth: 800, cssHeight: 600, dpr: 2 });
    expect([h.canvas.width, h.canvas.height]).toEqual([1600, 1200]);
    expect(ctx.renderScale).toBe(1);
    expect(ctx.quality).toBe("auto");
    expect(ctx.reduceFlashing).toBe(true);
    expect(ctx.assets.url("a.png")).toBe(`${BASE}a.png`);
  });

  it("fills params missing from init with manifest defaults", async () => {
    const h = harness({
      init: { params: { hue: 10 } },
      manifest: { params: [{ id: "hue", type: "number", default: 1 }, { id: "on", type: "boolean", default: true }] },
    });
    await h.rt.start();
    expect(h.create.mock.calls[0][0].params).toEqual({ hue: 10, on: true });
  });

  it("posts ready only after create resolved and the first frame rendered", async () => {
    const h = harness();
    await h.rt.start();
    expect(h.types()).not.toContain("ready");
    h.tick(16);
    expect(h.plugin.frame).toHaveBeenCalledTimes(1);
    expect(h.types().filter((t) => t === "ready")).toHaveLength(1);
    h.tick(32);
    expect(h.types().filter((t) => t === "ready")).toHaveLength(1);
  });

  it("passes a silent zero frame before any audio arrives", async () => {
    const h = harness();
    await h.rt.start();
    h.tick(16);
    const audio = h.plugin.frame.mock.calls[0][0];
    expect(audio.silent).toBe(true);
    expect(audio.bands.length).toBe(64);
    expect(audio.bass).toBe(0);
  });

  it("renders the newest frame; frames between rAFs replace each other", async () => {
    const h = harness();
    await h.rt.start();
    const seen = /** @type {number[]} */ ([]);
    h.plugin.frame.mockImplementation((/** @type {any} */ a) => seen.push(a.frameIndex));
    h.rt.handleMessage(encodeFrame({ frameIndex: 1 }));
    h.rt.handleMessage(encodeFrame({ frameIndex: 2 }));
    h.tick(16);
    h.tick(33);
    h.rt.handleMessage(encodeFrame({ frameIndex: 3 }));
    h.tick(50);
    expect(seen).toEqual([2, 2, 3]);
    expect(h.plugin.frame.mock.calls[0][0]).toBe(h.plugin.frame.mock.calls[2][0]);
  });

  it("ignores malformed frames", async () => {
    const h = harness();
    await h.rt.start();
    h.rt.handleMessage(encodeFrame({ frameIndex: 5 }));
    h.rt.handleMessage(encodeFrame({ magic: 1, frameIndex: 6 }));
    h.rt.handleMessage(new ArrayBuffer(3));
    h.tick(16);
    expect(h.plugin.frame.mock.calls[0][0].frameIndex).toBe(5);
  });

  it("passes time {now, dt ≤ 0.1, frame} in seconds", async () => {
    const h = harness();
    await h.rt.start();
    /** @type {any[]} */
    const times = [];
    h.plugin.frame.mockImplementation((/** @type {any} */ _a, /** @type {any} */ t) => times.push({ ...t }));
    h.tick(1000);
    h.tick(1016);
    h.tick(1516);
    expect(times[0]).toEqual({ now: 0, dt: 0, frame: 0 });
    expect(times[1].now).toBeCloseTo(0.016);
    expect(times[1].dt).toBeCloseTo(0.016);
    expect(times[1].frame).toBe(1);
    expect(times[2].now).toBeCloseTo(0.516);
    expect(times[2].dt).toBe(0.1);
    expect(times[2].frame).toBe(2);
  });
});

describe("runtime errors", () => {
  const errors = (/** @type {any[]} */ posted) => posted.filter((m) => m.type === "error");

  it("reports a throwing create as fatal with file and line, and never starts the loop", async () => {
    const h = harness({
      create: () => {
        const e = new Error("boom");
        e.stack = `create@${BASE}src/main.js:7:3`;
        throw e;
      },
    });
    await h.rt.start();
    expect(errors(h.posted)).toEqual([{ type: "error", message: "Error: boom", file: "src/main.js", line: 7, fatal: true }]);
    expect(h.pendingRaf()).toBe(0);
  });

  it("reports a rejecting async create as fatal", async () => {
    const h = harness({ create: async () => Promise.reject(new TypeError("async boom")) });
    await h.rt.start();
    expect(errors(h.posted)[0]).toMatchObject({ message: "TypeError: async boom", fatal: true });
  });

  it("reports a create that returns no frame function as fatal", async () => {
    const h = harness({ create: () => ({}) });
    await h.rt.start();
    expect(errors(h.posted)[0]).toMatchObject({ message: expect.stringMatching(/frame/), fatal: true });
  });

  it("reports context creation failures as fatal without loading the plugin", async () => {
    const h = harness({
      createContext: async () => {
        throw new Error("WebGPU is unavailable; use fallback 'pulse-2d'");
      },
    });
    await h.rt.start();
    expect(errors(h.posted)[0]).toMatchObject({ message: expect.stringMatching(/pulse-2d/), fatal: true });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("stops after 3 consecutive frame errors; only the third is fatal", async () => {
    const plugin = { frame: vi.fn(() => { throw new Error("frame boom"); }) };
    const h = harness({ plugin });
    await h.rt.start();
    h.tick(16);
    h.tick(32);
    expect(errors(h.posted).map((e) => e.fatal)).toEqual([false, false]);
    h.tick(48);
    expect(errors(h.posted).map((e) => e.fatal)).toEqual([false, false, true]);
    expect(errors(h.posted)[2].message).toBe("Error: frame boom");
    expect(h.pendingRaf()).toBe(0);
    h.tick(64);
    expect(plugin.frame).toHaveBeenCalledTimes(3);
    expect(h.types()).not.toContain("ready");
  });

  it("resets the consecutive count after a good frame", async () => {
    let n = 0;
    const plugin = { frame: vi.fn(() => { if (n++ % 2 === 0) throw new Error("flaky"); }) };
    const h = harness({ plugin });
    await h.rt.start();
    for (let i = 1; i <= 10; i++) h.tick(i * 16);
    expect(errors(h.posted).every((e) => !e.fatal)).toBe(true);
    expect(plugin.frame).toHaveBeenCalledTimes(10);
  });

  it("reports async errors (window error / unhandledrejection) as non-fatal", async () => {
    const h = harness();
    await h.rt.start();
    h.rt.reportError(new RangeError("later"));
    expect(errors(h.posted)).toHaveLength(1);
    expect(errors(h.posted)[0]).toMatchObject({ type: "error", message: "RangeError: later", fatal: false });
  });

  it("ctx.log posts plain text", async () => {
    const h = harness();
    await h.rt.start();
    h.create.mock.calls[0][0].log("hi", 1, { a: 2 });
    expect(h.posted).toContainEqual({ type: "log", text: 'hi 1 {"a":2}' });
  });
});

describe("runtime port messages", () => {
  it("params: updates live ctx.params, then calls params(changed) with valid keys only", async () => {
    const plugin = { frame: vi.fn(), params: vi.fn() };
    const h = harness({ plugin, init: { params: { hue: 1, on: true } } });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    plugin.params.mockImplementation(() => expect(ctx.params.hue).toBe(200));
    h.rt.handleMessage({ type: "params", changed: { hue: 200, bad: { x: 1 } } });
    expect(plugin.params).toHaveBeenCalledWith({ hue: 200 });
    expect(ctx.params).toEqual({ hue: 200, on: true });
  });

  it("params: a throwing params hook is reported non-fatally", async () => {
    const plugin = { frame: vi.fn(), params: vi.fn(() => { throw new Error("p"); }) };
    const h = harness({ plugin });
    await h.rt.start();
    h.rt.handleMessage({ type: "params", changed: { a: 1 } });
    expect(h.posted.find((m) => m.type === "error")).toMatchObject({ message: "Error: p", fatal: false });
  });

  it("settings: reduceFlashing and quality are live on ctx", async () => {
    const h = harness();
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    h.rt.handleMessage({ type: "settings", reduceFlashing: false, quality: "battery" });
    expect(ctx.reduceFlashing).toBe(false);
    expect(ctx.quality).toBe("battery");
    h.rt.handleMessage({ type: "settings", quality: "nonsense", reduceFlashing: "yes" });
    expect(ctx.quality).toBe("battery");
    expect(ctx.reduceFlashing).toBe(false);
  });

  it("visibility: hidden stops rAF; visible resumes without counting the hidden time", async () => {
    const h = harness();
    await h.rt.start();
    /** @type {number[]} */
    const nows = [];
    h.plugin.frame.mockImplementation((/** @type {any} */ _a, /** @type {any} */ t) => nows.push(t.now));
    h.tick(0);
    h.tick(16);
    h.rt.handleMessage({ type: "visibility", visible: false });
    expect(h.pendingRaf()).toBe(0);
    h.clock.t = 60_000;
    h.rt.handleMessage({ type: "visibility", visible: true });
    h.tick(60_000);
    h.tick(60_016);
    expect(nows[2]).toBeCloseTo(0.016);
    expect(nows[3]).toBeCloseTo(0.032);
  });

  it("init visible:false starts paused", async () => {
    const h = harness({ init: { visible: false } });
    await h.rt.start();
    expect(h.pendingRaf()).toBe(0);
    h.rt.handleMessage({ type: "visibility", visible: true });
    expect(h.pendingRaf()).toBe(1);
  });

  it("dispose: calls dispose(), stops, then acknowledges with {type:'disposed'}", async () => {
    const plugin = { frame: vi.fn(), dispose: vi.fn() };
    const h = harness({ plugin });
    await h.rt.start();
    h.tick(16);
    h.rt.handleMessage({ type: "dispose" });
    expect(plugin.dispose).toHaveBeenCalledTimes(1);
    expect(h.pendingRaf()).toBe(0);
    expect(h.posted.at(-1)).toEqual({ type: "disposed" });
    h.rt.handleMessage({ type: "visibility", visible: true });
    expect(h.pendingRaf()).toBe(0);
  });

  it("dispose: a throwing dispose is reported but still acknowledged", async () => {
    const plugin = { frame: vi.fn(), dispose: vi.fn(() => { throw new Error("d"); }) };
    const h = harness({ plugin });
    await h.rt.start();
    h.rt.handleMessage({ type: "dispose" });
    expect(h.types().slice(-2)).toEqual(["error", "disposed"]);
  });

  it("ignores unknown and malformed messages", async () => {
    const h = harness();
    await h.rt.start();
    for (const m of [null, 1, "x", { type: "nope" }, { type: "params" }, { type: "params", changed: 3 }, { type: "visibility" }]) {
      expect(() => h.rt.handleMessage(m)).not.toThrow();
    }
    expect(h.pendingRaf()).toBe(1);
  });
});

describe("runtime sizing and quality", () => {
  it("caps the DPR with maxDpr (null = native)", async () => {
    const h = harness({ init: { maxDpr: 1.5 }, dpr: 2 });
    await h.rt.start();
    expect(h.create.mock.calls[0][0].size).toMatchObject({ width: 1200, height: 900, dpr: 1.5 });
  });

  it("settings.maxDpr re-sizes and calls resize(size) with ctx.size", async () => {
    const plugin = { frame: vi.fn(), resize: vi.fn() };
    const h = harness({ plugin, dpr: 2 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    h.rt.handleMessage({ type: "settings", maxDpr: 1 });
    expect(plugin.resize).toHaveBeenCalledTimes(1);
    expect(plugin.resize.mock.calls[0][0]).toBe(ctx.size);
    expect(ctx.size).toMatchObject({ width: 800, height: 600, dpr: 1 });
    expect([h.canvas.width, h.canvas.height]).toEqual([800, 600]);
  });

  it("setCssSize updates ctx.size before resize, and skips no-op resizes", async () => {
    const plugin = { frame: vi.fn(), resize: vi.fn() };
    const h = harness({ plugin, dpr: 1 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    plugin.resize.mockImplementation((/** @type {any} */ s) => expect(s.cssWidth).toBe(1024));
    h.rt.setCssSize(1024, 768);
    h.rt.setCssSize(1024, 768);
    expect(plugin.resize).toHaveBeenCalledTimes(1);
    expect(ctx.size).toEqual({ width: 1024, height: 768, cssWidth: 1024, cssHeight: 768, dpr: 1 });
  });

  it("renderScaleMax caps the render scale", async () => {
    const h = harness({ init: { renderScaleMax: 0.75 }, dpr: 2 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    expect(ctx.renderScale).toBe(0.75);
    expect(ctx.size).toMatchObject({ width: 1200, dpr: 1.5 });
  });

  it("auto quality lowers renderScale after 2 s over budget and resizes", async () => {
    const plugin = { frame: vi.fn(), resize: vi.fn() };
    const h = harness({ plugin, dpr: 1 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    for (let t = 0; t <= 2600; t += 40) h.tick(t);
    expect(ctx.renderScale).toBeCloseTo(0.9);
    expect(ctx.size).toMatchObject({ width: 720, height: 540 });
    expect(plugin.resize).toHaveBeenCalled();
  });

  it("non-auto quality never adapts", async () => {
    const h = harness({ init: { quality: "high" }, dpr: 1 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    for (let t = 0; t <= 5000; t += 40) h.tick(t);
    expect(ctx.renderScale).toBe(1);
  });

  it("switching quality away from auto restores full scale", async () => {
    const h = harness({ dpr: 1 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    for (let t = 0; t <= 2600; t += 40) h.tick(t);
    expect(ctx.renderScale).toBeLessThan(1);
    h.rt.handleMessage({ type: "settings", quality: "balanced" });
    expect(ctx.renderScale).toBe(1);
    expect(ctx.size.width).toBe(800);
  });

  it("fpsCap skips display frames to hold the cap", async () => {
    const h = harness({ init: { fpsCap: 30 } });
    await h.rt.start();
    for (let i = 0; i < 60; i++) h.tick((i * 1000) / 60);
    expect(h.plugin.frame).toHaveBeenCalledTimes(30);
    expect(h.pendingRaf()).toBe(1);
    h.rt.handleMessage({ type: "settings", fpsCap: null });
    for (let i = 60; i < 120; i++) h.tick((i * 1000) / 60);
    expect(h.plugin.frame).toHaveBeenCalledTimes(90);
  });
});

describe("runtime quality presets", () => {
  it("derives maxDpr/fpsCap from the quality preset when the message omits them", async () => {
    const h = harness({ init: { quality: "battery", maxDpr: undefined, fpsCap: undefined }, dpr: 2 });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    expect(ctx.size.dpr).toBe(1);
    for (let i = 0; i < 60; i++) h.tick((i * 1000) / 60);
    expect(h.plugin.frame).toHaveBeenCalledTimes(30);
    h.rt.handleMessage({ type: "settings", quality: "balanced" });
    expect(ctx.size.dpr).toBe(1.5);
    h.rt.handleMessage({ type: "settings", quality: "high" });
    expect(ctx.size.dpr).toBe(2);
    h.rt.handleMessage({ type: "settings", quality: "battery", maxDpr: 2 });
    expect(ctx.size.dpr).toBe(2);
  });
});

describe("runtime three", () => {
  const fakeThree = () => ({
    THREE: {},
    renderer: { setSize: vi.fn(), render: vi.fn(), dispose: vi.fn() },
    scene: { name: "default" },
    camera: { isPerspectiveCamera: true, aspect: 1, updateProjectionMatrix: vi.fn() },
    autoRender: true,
  });

  it("sizes the renderer (pixel ratio 1) and camera aspect", async () => {
    const three = fakeThree();
    const h = harness({ contexts: { ctx2d: null, three }, manifest: { renderer: "three" }, dpr: 2 });
    await h.rt.start();
    expect(three.renderer.setSize).toHaveBeenLastCalledWith(1600, 1200, false);
    expect(three.camera.aspect).toBeCloseTo(800 / 600);
    h.rt.setCssSize(400, 400);
    expect(three.renderer.setSize).toHaveBeenLastCalledWith(800, 800, false);
    expect(three.camera.aspect).toBe(1);
    expect(three.camera.updateProjectionMatrix).toHaveBeenCalled();
  });

  it("auto-renders the current scene/camera after frame unless autoRender is false", async () => {
    const three = fakeThree();
    const h = harness({ contexts: { ctx2d: null, three }, manifest: { renderer: "three" } });
    await h.rt.start();
    const ctx = h.create.mock.calls[0][0];
    const order = /** @type {string[]} */ ([]);
    h.plugin.frame.mockImplementation(() => order.push("frame"));
    three.renderer.render.mockImplementation(() => order.push("render"));
    h.tick(16);
    expect(order).toEqual(["frame", "render"]);
    const myScene = { name: "mine" };
    ctx.three.scene = myScene;
    h.tick(32);
    expect(three.renderer.render).toHaveBeenLastCalledWith(myScene, three.camera);
    ctx.three.autoRender = false;
    h.tick(48);
    expect(three.renderer.render).toHaveBeenCalledTimes(2);
  });
});

describe("runtime perf and onsets", () => {
  it("posts perf once per second with renderScale", async () => {
    const h = harness();
    await h.rt.start();
    for (let i = 0; i <= 61; i++) h.tick(1000 + (i * 1000) / 60);
    const perf = h.posted.filter((m) => m.type === "perf");
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ type: "perf", renderScale: 1, dropped: 0 });
    expect(perf[0].fps).toBeGreaterThan(55);
    expect(perf[0].frameMsP50).toBeCloseTo(16.67, 1);
    for (const k of ["frameMsP99", "pluginMsP50", "sdkMsP50"]) expect(typeof perf[0][k]).toBe("number");
  });

  it("measures plugin CPU time around frame", async () => {
    const h = harness();
    await h.rt.start();
    h.plugin.frame.mockImplementation(() => { h.clock.t += 4; });
    for (let i = 0; i <= 70; i++) h.tick(1000 + (i * 1000) / 60);
    const perf = h.posted.find((m) => m.type === "perf");
    expect(perf.pluginMsP50).toBeCloseTo(4);
    expect(perf.sdkMsP50).toBeCloseTo(0);
  });

  it("latches an onset from a frame replaced before render; reports onsetSeen once", async () => {
    const h = harness();
    await h.rt.start();
    /** @type {boolean[]} */
    const onsets = [];
    h.plugin.frame.mockImplementation((/** @type {any} */ a) => onsets.push(a.onset));
    h.rt.handleMessage(encodeFrame({ frameIndex: 10, onset: true }));
    h.rt.handleMessage(encodeFrame({ frameIndex: 11 }));
    h.tick(16);
    h.tick(32);
    expect(onsets).toEqual([true, false]);
    expect(h.posted.filter((m) => m.type === "onsetSeen")).toEqual([{ type: "onsetSeen", frameIndex: 10 }]);
    h.rt.handleMessage(encodeFrame({ frameIndex: 12, onset: true }));
    h.tick(48);
    expect(h.posted.filter((m) => m.type === "onsetSeen").at(-1)).toEqual({ type: "onsetSeen", frameIndex: 12 });
  });
});

describe("runtime context loss", () => {
  it("disposes on loss, posts contextLost, and re-creates on restore", async () => {
    const first = { frame: vi.fn(), dispose: vi.fn() };
    const second = { frame: vi.fn() };
    const reset = vi.fn();
    const instances = [first, second];
    const h = harness({ create: () => instances.shift(), contexts: { reset } });
    await h.rt.start();
    h.tick(16);
    h.rt.contextLost();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(h.pendingRaf()).toBe(0);
    expect(h.posted.at(-1)).toEqual({ type: "contextLost" });
    h.rt.handleMessage({ type: "visibility", visible: true });
    expect(h.pendingRaf()).toBe(0);
    await h.rt.contextRestored();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[1][0]).toBe(h.create.mock.calls[0][0]);
    h.tick(32);
    expect(second.frame).toHaveBeenCalledTimes(1);
    expect(first.frame).toHaveBeenCalledTimes(1);
  });

  it("a failing re-create is fatal", async () => {
    let n = 0;
    const h = harness({ create: () => { if (n++) throw new Error("again"); return { frame: vi.fn() }; } });
    await h.rt.start();
    h.rt.contextLost();
    await h.rt.contextRestored();
    expect(h.posted.at(-1)).toMatchObject({ type: "error", message: "Error: again", fatal: true });
  });

  it("ignores loss/restore after dispose", async () => {
    const h = harness();
    await h.rt.start();
    h.rt.handleMessage({ type: "dispose" });
    h.rt.contextLost();
    await h.rt.contextRestored();
    expect(h.types()).not.toContain("contextLost");
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

describe("runtime dispose during async create", () => {
  it("disposes the late instance and never renders it", async () => {
    const plugin = { frame: vi.fn(), dispose: vi.fn() };
    /** @type {(v: any) => void} */
    let resolve = () => {};
    const h = harness({ create: () => new Promise((r) => (resolve = r)) });
    const started = h.rt.start();
    await new Promise((r) => setTimeout(r, 0));
    h.rt.handleMessage({ type: "dispose" });
    resolve(plugin);
    await started;
    expect(plugin.dispose).toHaveBeenCalledTimes(1);
    expect(h.pendingRaf()).toBe(0);
  });
});
