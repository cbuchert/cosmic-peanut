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
