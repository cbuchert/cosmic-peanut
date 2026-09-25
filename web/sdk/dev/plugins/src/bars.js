// @ts-check
/** @type {import('../../../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const g = /** @type {CanvasRenderingContext2D} */ (ctx.ctx2d);
  ctx.log("bars created", ctx.size.width, ctx.size.height);
  return {
    frame(audio) {
      const { width, height } = ctx.size;
      g.fillStyle = "#000";
      g.fillRect(0, 0, width, height);
      g.fillStyle = `hsl(${ctx.params.hue} 80% 60%)`;
      const n = audio.bands.length, w = width / n;
      for (let i = 0; i < n; i++) {
        const h = audio.bands[i] * height;
        g.fillRect(i * w, height - h, w - 1, h);
      }
    },
  };
}
