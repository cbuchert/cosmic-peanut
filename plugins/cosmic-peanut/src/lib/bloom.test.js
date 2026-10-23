// @ts-check
import { describe, expect, it } from "vitest";
import { MAX_LEVELS, bloomChain, createBloom } from "./bloom.js";

describe("bloomChain", () => {
  it("halves from half the scene's size, MAX_LEVELS mips at 1440p", () => {
    expect(MAX_LEVELS).toBe(6);
    expect(bloomChain(2560, 1440)).toEqual([
      [1280, 720],
      [640, 360],
      [320, 180],
      [160, 90],
      [80, 45],
      [40, 22],
    ]);
  });
  it("stops before a side would drop under 4 texels, and portrait works the same", () => {
    expect(bloomChain(64, 36)).toEqual([
      [32, 18],
      [16, 9],
      [8, 4],
    ]);
    expect(bloomChain(36, 64)).toEqual([
      [18, 32],
      [9, 16],
      [4, 8],
    ]);
  });
  it("always has one level, however small the canvas", () => {
    expect(bloomChain(1, 1)).toEqual([[1, 1]]);
    expect(bloomChain(5, 3)).toEqual([[2, 1]]);
  });
});

/** A counting WebGL2 stand-in: allocations (create*, texImage2D) and draws. */
function countingGl() {
  const calls = /** @type {Record<string, number>} */ ({});
  /** @type {{ level: number, w: number, h: number }[]} */
  const viewports = [];
  const gl = new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (/^[A-Z0-9_]+$/.test(name)) return name;
        return (/** @type {any[]} */ ...a) => {
          calls[name] = (calls[name] ?? 0) + 1;
          if (name === "viewport") viewports.push({ level: -1, w: a[2], h: a[3] });
          return {};
        };
      },
    },
  );
  return { gl: /** @type {WebGL2RenderingContext} */ (/** @type {unknown} */ (gl)), calls, viewports };
}

describe("createBloom", () => {
  const prog = { program: /** @type {WebGLProgram} */ ({}), u: {} };
  const fmt = { internal: 0x881a, format: 0x1908, type: 0x140b };

  it("allocates its mips once per size: a resize to the same size or a frame allocates nothing", () => {
    const { gl, calls, viewports } = countingGl();
    const bloom = createBloom(gl, prog, prog, fmt);
    const made = calls.createTexture ?? 0;
    expect(made).toBe(MAX_LEVELS);
    bloom.resize(2560, 1440);
    expect(calls.texImage2D).toBe(6);
    expect(bloom.levels).toBe(6);
    for (const k of Object.keys(calls)) calls[k] = 0;
    bloom.resize(2560, 1440);
    viewports.length = 0;
    for (let f = 0; f < 10; f++) bloom.run(/** @type {WebGLTexture} */ ({}), /** @type {WebGLVertexArrayObject} */ ({}));
    expect(calls.texImage2D ?? 0).toBe(0);
    const creates = Object.keys(calls).filter((k) => k.startsWith("create") && calls[k] > 0);
    expect(creates).toEqual([]);
    // Per run: 6 downsamples then 5 upsamples, each a fullscreen triangle into its mip.
    expect(calls.drawArrays).toBe(10 * 11);
    expect(viewports.slice(0, 11).map((v) => v.w)).toEqual([1280, 640, 320, 160, 80, 40, 80, 160, 320, 640, 1280]);
  });

  it("reallocates on a real resize", () => {
    const { gl, calls } = countingGl();
    const bloom = createBloom(gl, prog, prog, fmt);
    bloom.resize(2560, 1440);
    calls.texImage2D = 0;
    bloom.resize(64, 36);
    expect(calls.texImage2D).toBe(3);
    expect(bloom.levels).toBe(3);
  });
});
