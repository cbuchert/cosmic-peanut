import { describe, it, expect, vi } from "vitest";
import { createAssets } from "./assets.js";

const BASE = "http://127.0.0.1:5000/r/abc/";

/** @param {Record<string, string>} files */
function fakeFetch(files) {
  return vi.fn(async (/** @type {string} */ url) => {
    const body = files[url];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
  });
}

describe("assets", () => {
  it("resolves repo-relative paths against the base", () => {
    const a = createAssets(BASE, { fetch: fakeFetch({}) });
    expect(a.url("src/tex.png")).toBe(`${BASE}src/tex.png`);
    expect(a.url("./shaders/a.frag")).toBe(`${BASE}shaders/a.frag`);
  });

  it.each([
    "", "../secret", "a/../../b", "a/../b", "%2e%2e/x", "a/%2E%2e/b", "/etc/passwd", "//evil.example/x",
    "http://evil.example/x", "data:text/plain,hi", "javascript:alert(1)", "blob:x", "C:/x", "..\\x", "a\\b",
  ])("rejects %j", (bad) => {
    const a = createAssets(BASE, { fetch: fakeFetch({}) });
    expect(() => a.url(bad)).toThrow(/asset path/);
  });

  it("rejects non-string paths", () => {
    const a = createAssets(BASE, { fetch: fakeFetch({}) });
    expect(() => a.url(/** @type {any} */ (42))).toThrow(/asset path/);
  });

  it("loads text, json and arrayBuffer through fetch", async () => {
    const f = fakeFetch({ [`${BASE}a.txt`]: "hello", [`${BASE}b.json`]: '{"x":1}' });
    const a = createAssets(BASE, { fetch: f });
    expect(await a.text("a.txt")).toBe("hello");
    expect(await a.json("b.json")).toEqual({ x: 1 });
    expect(new Uint8Array(await a.arrayBuffer("a.txt"))[0]).toBe(104);
  });

  it("rejects (not throws) for escaping paths and HTTP errors", async () => {
    const f = fakeFetch({});
    const a = createAssets(BASE, { fetch: f });
    const p = a.text("../x");
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toThrow(/asset path/);
    await expect(a.json("missing.json")).rejects.toThrow(/missing\.json.*404/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("decodes images into ImageBitmaps", async () => {
    const bitmap = { width: 2, height: 2 };
    const createImageBitmap = vi.fn(async (/** @type {Blob} */ _b) => /** @type {ImageBitmap} */ (/** @type {unknown} */ (bitmap)));
    const a = createAssets(BASE, { fetch: fakeFetch({ [`${BASE}i.png`]: "PNG" }), createImageBitmap });
    expect(await a.image("i.png")).toBe(bitmap);
    expect(createImageBitmap.mock.calls[0][0]).toBeInstanceOf(Blob);
  });
});
