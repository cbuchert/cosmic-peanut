// @ts-check
/** @type {import('../../../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const { device, context } = /** @type {import('../../../tidalviz').WebGPUHandles} */ (ctx.gpu);
  return {
    frame(audio) {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store",
          clearValue: { r: audio.bass * 0.5, g: 0.2, b: 0.4, a: 1 } }],
      });
      pass.end();
      device.queue.submit([enc.finish()]);
    },
  };
}
