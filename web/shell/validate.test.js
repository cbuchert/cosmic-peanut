import { describe, expect, it } from "vitest";
import { parseHostMessage, parsePluginMessage } from "./validate.js";

const viz = {
  key: "builtin/bars",
  repo: "builtin",
  id: "bars",
  name: "Bars",
  description: "Classic bars",
  author: "Tidalviz",
  renderer: "2d",
  thumbnailUrl: null,
  params: [{ id: "hue", type: "number", label: "Hue", min: 0, max: 360, default: 200 }],
  values: { hue: 120 },
  disabled: false,
  dev: false,
  entryUrl: "http://127.0.0.1:2/r/builtin/bars.js",
  pageUrl: "http://127.0.0.1:2/v/builtin/bars/",
};

describe("parseHostMessage", () => {
  it("parses a valid status message", () => {
    expect(parseHostMessage('{"type":"status","level":"warn","text":"hi"}')).toEqual({
      type: "status",
      level: "warn",
      text: "hi",
    });
  });

  it("rejects bad JSON, non-objects, unknown types and wrong field types", () => {
    expect(parseHostMessage("{")).toBeNull();
    expect(parseHostMessage("42")).toBeNull();
    expect(parseHostMessage('{"type":"nope"}')).toBeNull();
    expect(parseHostMessage('{"type":"status","level":"loud","text":"x"}')).toBeNull();
    expect(parseHostMessage('{"type":"status","level":"info","text":5}')).toBeNull();
  });

  it("parses hello and drops invalid visualizers and params", () => {
    const bad = { ...viz, key: 5 };
    const badParam = { id: "x", type: "number", label: "X", min: 0, max: "1", default: 0 };
    const msg = parseHostMessage(
      JSON.stringify({
        type: "hello",
        version: 1,
        pluginOrigin: "http://127.0.0.1:2",
        visualizers: [{ ...viz, params: [...viz.params, badParam] }, bad],
        repos: [{ repo: "builtin", url: null, path: null, commit: null, previous: null, dev: false, builtin: true }],
        settings: { quality: "balanced", reduceFlashing: false, extra: 1 },
        sources: [{ id: "system", name: "All audio" }, { id: 3 }],
        activeSource: "system",
        active: "builtin/bars",
        dev: true,
      }),
    );
    expect(msg?.type).toBe("hello");
    if (msg?.type !== "hello") return;
    expect(msg.visualizers).toHaveLength(1);
    expect(msg.visualizers[0].params).toHaveLength(1);
    expect(msg.visualizers[0].values).toEqual({ hue: 120 });
    expect(msg.repos[0].builtin).toBe(true);
    expect(msg.sources).toEqual([{ id: "system", name: "All audio" }]);
    expect(msg.settings.quality).toBe("balanced");
    expect(msg.settings.reduceFlashing).toBe(false);
    expect(msg.active).toBe("builtin/bars");
    expect(msg.dev).toBe(true);
  });

  it("validates each param type", () => {
    const params = [
      { id: "a", type: "number", label: "A", min: 0, max: 1, step: 0.1, default: 0.5 },
      { id: "b", type: "color", label: "B", default: "#ff00aa" },
      { id: "c", type: "boolean", label: "C", default: true },
      { id: "d", type: "select", label: "D", options: ["x", "y"], default: "y" },
      { id: "e", type: "select", label: "E", options: ["x", 1], default: "x" },
      { id: "f", type: "color", label: "F", default: "red" },
      { id: "g", type: "html", label: "G", default: "" },
    ];
    const msg = parseHostMessage(JSON.stringify({ type: "visualizers", visualizers: [{ ...viz, params }], repos: [] }));
    if (msg?.type !== "visualizers") throw new Error("expected visualizers");
    expect(msg.visualizers[0].params.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("parses the small host messages", () => {
    const ok = [
      { type: "reload", key: "k" },
      { type: "manifestError", repo: "r", errors: [{ path: "/a", message: "bad" }] },
      { type: "sources", sources: [{ id: "app:12", name: "Music" }], active: "app:12" },
      { type: "silence", silent: true, seconds: 4 },
      { type: "stats", hostCpu: 3, rssMb: 90, analysisMsP50: 0.3, captureToSendMsP95: 4, droppedFrames: 0, latencyMsP95: 20 },
      { type: "installPrompt", id: "i1", url: "https://x/y", commit: "abc", visualizers: [{ id: "v", name: "V" }] },
      { type: "installResult", id: "i1", ok: false, error: "nope" },
      { type: "updates", repos: [{ repo: "r", commit: "c", message: "m" }] },
      { type: "disabled", key: "k", reason: "hung" },
    ];
    for (const m of ok) expect(parseHostMessage(JSON.stringify(m))).toEqual(m);
    const bad = [
      { type: "reload" },
      { type: "silence", silent: "yes", seconds: 4 },
      { type: "stats", hostCpu: "3" },
      { type: "installPrompt", id: "i1", url: 3, commit: "abc", visualizers: [] },
      { type: "installResult", id: "i1" },
      { type: "disabled", key: "k" },
    ];
    for (const m of bad) expect(parseHostMessage(JSON.stringify(m))).toBeNull();
  });

  it("stats latency is optional", () => {
    const m = { type: "stats", hostCpu: 3, rssMb: 90, analysisMsP50: 0.3, captureToSendMsP95: 4, droppedFrames: 0 };
    expect(parseHostMessage(JSON.stringify(m))).toEqual(m);
  });
});

describe("parsePluginMessage", () => {
  it("accepts well-formed port messages", () => {
    const ok = [
      { type: "ready" },
      { type: "error", message: "boom", file: "main.js", line: 3, fatal: true },
      { type: "error", message: "boom", fatal: false },
      { type: "perf", fps: 60, frameMsP50: 3, frameMsP99: 8, pluginMsP50: 1, renderScale: 1, dropped: 0 },
      { type: "onsetSeen", frameIndex: 12 },
      { type: "log", text: "hello" },
      { type: "contextLost" },
    ];
    for (const m of ok) expect(parsePluginMessage(m)).toEqual(m);
  });

  it("rejects malformed or foreign messages and strips extra fields", () => {
    const bad = [
      null,
      "ready",
      new ArrayBuffer(4),
      { type: "error", message: 1, fatal: true },
      { type: "error", message: "x" },
      { type: "perf", fps: "60" },
      { type: "onsetSeen", frameIndex: -1 },
      { type: "log", text: {} },
      { type: "evil" },
    ];
    for (const m of bad) expect(parsePluginMessage(m)).toBeNull();
    expect(parsePluginMessage({ type: "ready", html: "<b>" })).toEqual({ type: "ready" });
    expect(parsePluginMessage({ type: "error", message: "m", fatal: false, line: "x" })).toEqual({
      type: "error",
      message: "m",
      fatal: false,
    });
  });
});
