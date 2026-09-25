// @ts-check
/** @type {import('../../../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  return {
    frame(audio) {
      gl.viewport(0, 0, ctx.size.width, ctx.size.height);
      gl.clearColor(audio.bass * 0.5, 0.1, audio.onset ? 1 : 0.2, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
  };
}
