// @ts-check
import { describe, expect, it } from "vitest";
import { BLOOM_LEVELS, BLOOM_MIN, bloomSizes, createBloom } from "./lattice-bloom.js";

/**
 * A WebGL2 stand-in that counts calls by name (every method is a no-op returning a fresh token;
 * constants are numbers).
 */
function fakeGL() {
  /** @type {Record<string, number>} */
  const calls = {};
  let token = 0;
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(name)) return 1;
        return (/** @type {unknown[]} */ ..._args) => {
          calls[name] = (calls[name] ?? 0) + 1;
          if (name === "getExtension") return {};
          return { token: ++token };
        };
      },
    },
  );
  return { gl: /** @type {WebGL2RenderingContext} */ (/** @type {unknown} */ (gl)), calls };
}

describe("bloomSizes", () => {
  it("halves from half the scene size until the next level would drop under BLOOM_MIN", () => {
    const out = new Int32Array(BLOOM_LEVELS * 2);
    const n = bloomSizes(1715, 965, out);
    expect(n).toBe(BLOOM_LEVELS);
    expect([out[0], out[1]]).toEqual([858, 483]);
    for (let i = 1; i < n; i++) {
      expect(out[i * 2]).toBe(Math.ceil(out[i * 2 - 2] / 2));
      expect(out[i * 2 + 1]).toBe(Math.ceil(out[i * 2 - 1] / 2));
    }
    expect(Math.min(out[n * 2 - 2], out[n * 2 - 1])).toBeGreaterThanOrEqual(BLOOM_MIN);
  });

  it("uses fewer levels for a small scene, and always at least one", () => {
    const out = new Int32Array(BLOOM_LEVELS * 2);
    const n = bloomSizes(64, 40, out);
    expect(n).toBeLessThan(BLOOM_LEVELS);
    expect(Math.min(out[n * 2 - 2], out[n * 2 - 1])).toBeGreaterThanOrEqual(BLOOM_MIN);
    expect(Math.min(Math.ceil(out[n * 2 - 2] / 2), Math.ceil(out[n * 2 - 1] / 2))).toBeLessThan(BLOOM_MIN);
    expect(bloomSizes(3, 2, out)).toBe(1);
    expect([out[0], out[1]]).toEqual([2, 1]);
  });
});

describe("createBloom", () => {
  it("allocates its levels once per size change, not per frame", () => {
    const { gl, calls } = fakeGL();
    const bloom = createBloom(gl);
    expect(calls.texImage2D ?? 0).toBe(0); // nothing until the first resize
    bloom.resize(1715, 965);
    const n = bloom.levels;
    expect(n).toBe(BLOOM_LEVELS);
    expect(calls.texImage2D).toBe(n);
    expect(calls.createTexture).toBe(n);
    expect(calls.createFramebuffer).toBe(n);
    bloom.resize(1715, 965);
    expect(calls.texImage2D).toBe(n);
    bloom.resize(1280, 720);
    expect(calls.texImage2D).toBe(2 * n); // reallocated in place: same textures and framebuffers
    expect(calls.createTexture).toBe(n);
    bloom.dispose();
    expect(calls.deleteTexture).toBe(n);
    expect(calls.deleteFramebuffer).toBe(n);
  });

  it("runs the chain with no allocation: one draw per level down, one per level up", () => {
    const { gl, calls } = fakeGL();
    const bloom = createBloom(gl);
    bloom.resize(1715, 965);
    const before = { ...calls };
    const prog = { program: /** @type {WebGLProgram} */ ({}), u: {} };
    const src = /** @type {WebGLTexture} */ ({});
    bloom.render(src, 1715, 965, { karis: prog, down: prog, up: prog }, /** @type {WebGLVertexArrayObject} */ ({}));
    bloom.render(src, 1715, 965, { karis: prog, down: prog, up: prog }, /** @type {WebGLVertexArrayObject} */ ({}));
    for (const k of ["createTexture", "createFramebuffer", "texImage2D", "createProgram", "createBuffer"]) {
      expect(calls[k] ?? 0, k).toBe(before[k] ?? 0);
    }
    expect(calls.drawArrays).toBe(2 * (BLOOM_LEVELS + BLOOM_LEVELS - 1));
  });
});
