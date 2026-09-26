// @ts-check
/** Creates the rendering context a plugin's manifest asks for, with host-controlled options. */

/** @typedef {import("./runtime.js").RendererHandles} RendererHandles */

/** Host-controlled WebGL context options (PRD "SDK duties"). */
export const GL_OPTIONS = Object.freeze({
  powerPreference: /** @type {const} */ ("high-performance"),
  antialias: false,
  preserveDrawingBuffer: false,
  // Transparent, premultiplied canvas: the shell supplies the backdrop (black, or the desktop
  // when "Transparent background" is on). Plugins clear to 0,0,0,0 and output premultiplied color.
  alpha: true,
  premultipliedAlpha: true,
});

/** The requested renderer can't run here; `fallback` is the manifest's fallback entry id. */
export class RendererUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {string | undefined} fallback
   */
  constructor(message, fallback) {
    super(message);
    this.name = "RendererUnavailableError";
    this.fallback = fallback;
  }
}

/**
 * @param {import("./tidalviz").RendererKind} kind
 * @param {HTMLCanvasElement} canvas
 * @param {{ gpu?: GPU, importThree?: () => Promise<typeof import("three")>, fallback?: string }} deps
 * @returns {Promise<RendererHandles>}
 */
export async function createRendererContext(kind, canvas, deps) {
  /** @type {RendererHandles} */
  const h = { ctx2d: null, gl: null, gpu: null, three: null };
  switch (kind) {
    case "2d": {
      h.ctx2d = canvas.getContext("2d");
      if (!h.ctx2d) throw new RendererUnavailableError("Canvas 2D is unavailable", deps.fallback);
      return h;
    }
    case "webgl2": {
      h.gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext("webgl2", GL_OPTIONS));
      if (!h.gl) throw new RendererUnavailableError("WebGL2 is unavailable", deps.fallback);
      return h;
    }
    case "webgpu": {
      const unavailable = () =>
        new RendererUnavailableError(
          deps.fallback
            ? `WebGPU is unavailable; the host should run the fallback visualizer "${deps.fallback}"`
            : "WebGPU is unavailable and this visualizer declares no fallback",
          deps.fallback,
        );
      const gpu = deps.gpu;
      if (!gpu) throw unavailable();
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw unavailable();
      const device = await adapter.requestDevice();
      const context = /** @type {GPUCanvasContext | null} */ (canvas.getContext("webgpu"));
      if (!context) throw unavailable();
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });
      h.gpu = { adapter, device, context, format };
      return h;
    }
    case "three": {
      if (!deps.importThree) throw new RendererUnavailableError("three.js is unavailable", deps.fallback);
      const THREE = await deps.importThree();
      const renderer = new THREE.WebGLRenderer({ canvas, ...GL_OPTIONS });
      renderer.setPixelRatio(1); // the SDK sizes the drawing buffer in device pixels itself
      renderer.setClearColor(0x000000, 0);
      const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
      const defaults = () => {
        const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
        camera.position.z = 5;
        return { scene: new THREE.Scene(), camera, autoRender: true };
      };
      const three = { THREE, renderer, ...defaults() };
      h.three = three;
      h.reset = () => Object.assign(three, defaults());
      return h;
    }
    default:
      throw new RendererUnavailableError(`unknown renderer ${JSON.stringify(kind)}`, deps.fallback);
  }
}
