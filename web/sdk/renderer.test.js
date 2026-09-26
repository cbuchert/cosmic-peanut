import { describe, it, expect, vi } from "vitest";
import * as REAL_THREE from "three";
import { createRendererContext, GL_OPTIONS, RendererUnavailableError } from "./renderer.js";

/** @param {Record<string, any>} contexts */
function fakeCanvas(contexts) {
  return /** @type {any} */ ({
    clientWidth: 800,
    clientHeight: 400,
    getContext: vi.fn((/** @type {string} */ kind) => contexts[kind] ?? null),
  });
}

describe("createRendererContext", () => {
  it("2d: returns only ctx2d", async () => {
    const g = { kind: "2d" };
    const h = await createRendererContext("2d", fakeCanvas({ "2d": g }), {});
    expect(h).toMatchObject({ ctx2d: g, gl: null, gpu: null, three: null });
  });

  it("webgl2: uses the host context options", async () => {
    const gl = { kind: "gl" };
    const canvas = fakeCanvas({ webgl2: gl });
    const h = await createRendererContext("webgl2", canvas, {});
    expect(h.gl).toBe(gl);
    expect(canvas.getContext).toHaveBeenCalledWith("webgl2", GL_OPTIONS);
    // Transparent, premultiplied canvases: the shell supplies the backdrop (black or the desktop).
    expect(GL_OPTIONS).toEqual({
      powerPreference: "high-performance", antialias: false, preserveDrawingBuffer: false, alpha: true, premultipliedAlpha: true,
    });
  });

  it("webgl2: throws when unavailable", async () => {
    await expect(createRendererContext("webgl2", fakeCanvas({}), {})).rejects.toThrow(/WebGL2/);
  });

  it("webgpu: adapter, device, configured context and preferred format", async () => {
    const device = { kind: "device" };
    const adapter = { requestDevice: vi.fn(async () => device) };
    const context = { configure: vi.fn() };
    const gpu = { requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: () => "bgra8unorm" };
    const h = await createRendererContext("webgpu", fakeCanvas({ webgpu: context }), { gpu: /** @type {any} */ (gpu) });
    expect(h.gpu).toEqual({ adapter, device, context, format: "bgra8unorm" });
    expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
    expect(context.configure).toHaveBeenCalledWith({ device, format: "bgra8unorm", alphaMode: "premultiplied" });
  });

  it("webgpu: unavailable names the fallback", async () => {
    const p = createRendererContext("webgpu", fakeCanvas({}), { fallback: "pulse-2d" });
    await expect(p).rejects.toBeInstanceOf(RendererUnavailableError);
    await expect(p).rejects.toMatchObject({ fallback: "pulse-2d", message: expect.stringMatching(/"pulse-2d"/) });
    const noAdapter = { requestAdapter: async () => null, getPreferredCanvasFormat: () => "bgra8unorm" };
    await expect(createRendererContext("webgpu", fakeCanvas({}), { gpu: /** @type {any} */ (noAdapter) })).rejects.toThrow(
      /no fallback/,
    );
  });

  it("three: WebGLRenderer on the canvas with host options, default scene and camera", async () => {
    /** @type {any[]} */
    const made = [];
    class FakeRenderer {
      /** @param {any} opts */
      constructor(opts) {
        this.opts = opts;
        this.setPixelRatio = vi.fn();
        this.setClearColor = vi.fn();
        made.push(this);
      }
    }
    const THREE = { ...REAL_THREE, WebGLRenderer: FakeRenderer };
    const canvas = fakeCanvas({});
    const h = await createRendererContext("three", canvas, { importThree: async () => /** @type {any} */ (THREE) });
    const t = /** @type {any} */ (h.three);
    expect(t.THREE).toBe(THREE);
    expect(t.renderer).toBe(made[0]);
    expect(made[0].opts).toEqual({ canvas, ...GL_OPTIONS });
    expect(made[0].setPixelRatio).toHaveBeenCalledWith(1);
    expect(made[0].setClearColor).toHaveBeenCalledWith(0x000000, 0);
    expect(t.scene).toBeInstanceOf(REAL_THREE.Scene);
    expect(t.camera).toBeInstanceOf(REAL_THREE.PerspectiveCamera);
    expect([t.camera.fov, t.camera.near, t.camera.far, t.camera.position.z]).toEqual([60, 0.1, 1000, 5]);
    expect(t.camera.aspect).toBe(2);
    expect(t.autoRender).toBe(true);
    expect([h.ctx2d, h.gl, h.gpu]).toEqual([null, null, null]);

    t.scene = null;
    t.autoRender = false;
    /** @type {() => void} */ (h.reset)();
    expect(t.scene).toBeInstanceOf(REAL_THREE.Scene);
    expect(t.autoRender).toBe(true);
  });
});
