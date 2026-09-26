// @ts-check
/**
 * Pulsar — the Unknown Pleasures cover (Peter Saville's plot of pulsar CP 1919), live.
 *
 * Each ridge is one moment of audio: the 64 bands mirrored out from the centre (bass in the
 * middle) under a central envelope, roughened by the waveform. New ridges enter at the front
 * (bottom) at a fixed rate and recede upward. Hidden lines are removed by erasing under each
 * ridge (destination-out) before stroking it, back to front, so the canvas stays transparent
 * wherever nothing is drawn. Nothing is allocated per frame.
 */
import {
  advanceScroll,
  buildLine,
  centralEnvelope,
  createRing,
  drawRidges,
  ENV_HALF_WIDTH,
  ridgeLayout,
  resizeRing,
  ringPush,
  stepGain,
} from "./lib/ridges.js";

const POINTS = 161;
/** Manifest default of the Speed param (lines per second). */
const DEFAULT_SPEED = 10;
/** Used instead of the default when macOS "Reduce motion" is on. */
const REDUCED_SPEED = 4;

/** @type {import('../tidalviz').CreateVisualizer} */
export default function create(ctx) {
  const g = /** @type {CanvasRenderingContext2D} */ (ctx.ctx2d);
  let ring = createRing(lineCount(), POINTS);
  const lay = { left: 0, width: 0, top: 0, bottom: 0, spacing: 0, amp: 0 };
  let color = "#ffffff";
  let lineWidth = 1;
  const env = new Float32Array(POINTS);
  centralEnvelope(env, ENV_HALF_WIDTH);
  const scroll = { frac: 0 };
  const gainState = { level: 0.5 };
  let gain = 1;
  let seq = 0;

  function lineCount() {
    return Number(ctx.params.lines) || 80;
  }

  /** Everything derived from params and size, so frame() only reads plain numbers. */
  function relayout() {
    const { width: w, height: h, dpr } = ctx.size;
    ridgeLayout(w, h, ring.lines, Number(ctx.params.height), lay);
    lineWidth = Number(ctx.params.lineWidth) * dpr;
    const c = ctx.params.color;
    color = typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#ffffff";
  }
  relayout();

  return {
    frame(audio, time) {
      let rate = Number(ctx.params.speed);
      if (ctx.reduceMotion && rate === DEFAULT_SPEED) rate = REDUCED_SPEED;
      const n = advanceScroll(scroll, time.dt, rate, ring.lines);
      for (let k = 0; k < n; k++) {
        const raw = buildLine(ring.data, ringPush(ring), env, audio.bands, audio.waveform, gain, ++seq);
        gain = stepGain(gainState, raw, 1 / rate);
      }

      const { width: w, height: h } = ctx.size;
      g.clearRect(0, 0, w, h);
      drawRidges(g, ring, lay, scroll.frac, color, lineWidth);
    },

    resize() {
      relayout();
    },

    params(changed) {
      if ("lines" in changed && lineCount() !== ring.lines) ring = resizeRing(ring, lineCount());
      relayout();
    },
  };
}
