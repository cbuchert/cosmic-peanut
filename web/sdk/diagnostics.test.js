import { describe, it, expect } from "vitest";
import { locate, describeError, formatLog, MAX_TEXT } from "./diagnostics.js";

const ORIGIN = "http://127.0.0.1:5000";
const BASE = `${ORIGIN}/r/abc/`;

describe("locate (file/line from a stack)", () => {
  it("parses V8 stacks, skipping SDK frames, relative to the repo base", () => {
    const stack = [
      "TypeError: x is undefined",
      `    at run (${ORIGIN}/sdk/runtime.js:40:3)`,
      `    at Object.frame (${BASE}src/main.js:12:7)`,
    ].join("\n");
    expect(locate(stack, BASE)).toEqual({ file: "src/main.js", line: 12 });
  });

  it("parses V8 anonymous frames", () => {
    expect(locate(`Error: a\n    at ${BASE}lib/util.js:3:1`, BASE)).toEqual({ file: "lib/util.js", line: 3 });
  });

  it("parses WebKit/JSC stacks including module code", () => {
    const stack = `run@${ORIGIN}/sdk/runtime.js:40:3\nframe@${BASE}src/main.js:9:20\nmodule code@${BASE}src/main.js:1:1`;
    expect(locate(stack, BASE)).toEqual({ file: "src/main.js", line: 9 });
    expect(locate(`module code@${BASE}src/a.js:5:2`, BASE)).toEqual({ file: "src/a.js", line: 5 });
  });

  it("keeps a full URL for files outside the repo, and nothing for native-only stacks", () => {
    expect(locate(`f@${ORIGIN}/lib/three/three.module.js:100:2`, BASE)).toEqual({
      file: `${ORIGIN}/lib/three/three.module.js`,
      line: 100,
    });
    expect(locate("forEach@[native code]", BASE)).toEqual({});
    expect(locate(undefined, BASE)).toEqual({});
  });

  it("falls back to an SDK frame when nothing else is on the stack", () => {
    expect(locate(`boot@${ORIGIN}/sdk/sdk.js:7:1`, BASE)).toEqual({ file: `${ORIGIN}/sdk/sdk.js`, line: 7 });
  });
});

describe("describeError", () => {
  it("includes name and message plus location", () => {
    const e = new TypeError("bad");
    e.stack = `frame@${BASE}src/main.js:4:1`;
    expect(describeError(e, BASE)).toEqual({ message: "TypeError: bad", file: "src/main.js", line: 4 });
  });
  it("handles thrown non-errors and truncates", () => {
    expect(describeError("nope", BASE)).toEqual({ message: "nope" });
    expect(describeError(null, BASE)).toEqual({ message: "null" });
    expect(describeError(new Error("x".repeat(10_000)), BASE).message.length).toBeLessThanOrEqual(MAX_TEXT);
  });
});

describe("formatLog", () => {
  it("joins stringified args with spaces", () => {
    expect(formatLog(["a", 1, true, null, undefined, { b: [1, 2] }])).toBe('a 1 true null undefined {"b":[1,2]}');
  });
  it("survives cycles, errors, bigints and functions", () => {
    /** @type {any} */
    const cyc = {};
    cyc.self = cyc;
    expect(formatLog([cyc])).toBe("[object Object]");
    expect(formatLog([new Error("boom")])).toBe("Error: boom");
    expect(formatLog([10n])).toBe("10");
    expect(formatLog([function f() {}])).toMatch(/^function f/);
  });
  it("truncates to MAX_TEXT", () => {
    const t = formatLog(["y".repeat(MAX_TEXT * 2)]);
    expect(t.length).toBe(MAX_TEXT);
    expect(t.endsWith("…")).toBe(true);
  });
});
