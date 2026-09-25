// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { boot } from "./sdk.js";

const OPTS = {
  key: "abc/pulse",
  entry: "/r/abc/src/main.js",
  base: "/r/abc/",
  manifest: { id: "pulse", name: "Pulse", entry: "src/main.js", renderer: /** @type {const} */ ("2d") },
};

function fakePort() {
  return {
    /** @type {any[]} */ posted: [],
    /** @type {((e: any) => void) | null} */ onmessage: null,
    postMessage(/** @type {any} */ m) {
      this.posted.push(m);
    },
  };
}

/** @param {any} data @param {any[]} ports @param {any} [source] */
function sendInit(data, ports, source = window.parent) {
  window.dispatchEvent(new MessageEvent("message", { data, ports, source }));
}

const INIT = { type: "tidalviz:init", params: {}, quality: "auto", renderScaleMax: 1, maxDpr: null, fpsCap: null, reduceFlashing: true, visible: true };

/** @param {any} plugin */
function env(plugin) {
  const create = vi.fn(() => plugin);
  const importModule = vi.fn(async (/** @type {string} */ spec) => {
    if (spec.endsWith("/r/abc/src/main.js")) return { default: create };
    throw new Error(`unexpected import ${spec}`);
  });
  return { create, importModule };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // happy-dom has no 2D canvas implementation; the context object itself is irrelevant here
  // @ts-ignore
  HTMLCanvasElement.prototype.getContext = function () {
    return { fake: "2d" };
  };
});

describe("boot", () => {
  it("waits for one valid init from window.parent carrying a port, then creates the plugin", async () => {
    const plugin = { frame: vi.fn() };
    const e = env(plugin);
    const booted = boot(OPTS, { importModule: e.importModule });
    const port = fakePort();
    sendInit(INIT, [port], null); // wrong source
    sendInit({ type: "nope" }, [port]); // wrong type
    sendInit(INIT, []); // no port
    sendInit(INIT, [port]);
    const second = fakePort();
    sendInit(INIT, [second]);
    const rt = await booted;
    expect(rt).toBeTruthy();
    expect(e.create).toHaveBeenCalledTimes(1);
    const ctx = /** @type {any} */ (e.create.mock.calls[0])[0];
    expect(ctx.canvas).toBe(document.querySelector("canvas"));
    expect(ctx.assets.url("x.png")).toBe(new URL("/r/abc/x.png", location.href).href);
    expect(typeof port.onmessage).toBe("function");
    expect(second.onmessage).toBeNull();
  });

  it("routes port messages to the runtime and posts back over the port", async () => {
    const plugin = { frame: vi.fn(), params: vi.fn() };
    const e = env(plugin);
    const booted = boot(OPTS, { importModule: e.importModule });
    const port = fakePort();
    sendInit(INIT, [port]);
    await booted;
    /** @type {any} */ (port.onmessage)({ data: { type: "params", changed: { a: 1 } } });
    expect(plugin.params).toHaveBeenCalledWith({ a: 1 });
    /** @type {any} */ (e.create.mock.calls[0])[0].log("hello");
    expect(port.posted).toContainEqual({ type: "log", text: "hello" });
  });

  it("reports window errors and unhandled rejections non-fatally", async () => {
    const e = env({ frame: vi.fn() });
    const booted = boot(OPTS, { importModule: e.importModule });
    const port = fakePort();
    sendInit(INIT, [port]);
    await booted;
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("late"), message: "late" }));
    const rej = new Event("unhandledrejection");
    Object.assign(rej, { reason: new Error("rejected") });
    window.dispatchEvent(rej);
    const errs = port.posted.filter((m) => m.type === "error");
    expect(errs.map((m) => [m.message, m.fatal])).toEqual([
      ["Error: late", false],
      ["Error: rejected", false],
    ]);
  });

  it("handles webglcontextlost / restored on the canvas", async () => {
    const plugin = { frame: vi.fn(), dispose: vi.fn() };
    const e = env(plugin);
    const booted = boot(OPTS, { importModule: e.importModule });
    const port = fakePort();
    sendInit(INIT, [port]);
    const rt = await booted;
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector("canvas"));
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(plugin.dispose).toHaveBeenCalled();
    expect(port.posted).toContainEqual({ type: "contextLost" });
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    await vi.waitFor(() => expect(e.create).toHaveBeenCalledTimes(2));
    expect(rt).toBeTruthy();
  });
});
