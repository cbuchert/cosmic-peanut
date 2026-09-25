// @ts-check
/**
 * Adaptive render-scale controller for Auto quality (PRD "Adaptive quality"). Pure: the caller
 * feeds it timestamps and frame times, so it runs on a fake clock in tests.
 *
 * Frame time is smoothed with an EMA so a single long or short frame never flips the state.
 * "Over budget" means the smoothed frame time exceeds budget × overFactor (vsync jitter around
 * the budget is not a miss). Over budget continuously for `lowerAfterMs` ⇒ scale −= step
 * (floor `min`); not over budget continuously for `raiseAfterMs` ⇒ scale += step (ceiling `max`).
 * Both timers restart after every change so each step gets time to settle.
 *
 * @param {{ budgetMs: number, min?: number, max?: number, step?: number,
 *   lowerAfterMs?: number, raiseAfterMs?: number, overFactor?: number, alpha?: number }} o
 */
export function createQualityController(o) {
  const min = o.min ?? 0.5, step = o.step ?? 0.1;
  const lowerAfter = o.lowerAfterMs ?? 2000, raiseAfter = o.raiseAfterMs ?? 10000;
  const overFactor = o.overFactor ?? 1.2, alpha = o.alpha ?? 0.1;
  let budget = o.budgetMs;
  let max = o.max ?? 1;
  let ema = -1;
  let since = -1; // start of the current over/under streak (ms), -1 = no streak yet
  let over = false;

  /** @param {number} x */
  const round = (x) => Math.round(x * 100) / 100;

  const q = {
    scale: max,
    /** When false (quality ≠ auto) the scale is pinned to max. */
    enabled: true,
    /**
     * @param {number} nowMs timestamp of this frame
     * @param {number} frameMs duration of this frame (display interval)
     * @returns {number} the render scale to use
     */
    sample(nowMs, frameMs) {
      if (!q.enabled) return (q.scale = max);
      ema = ema < 0 ? frameMs : ema + alpha * (frameMs - ema);
      const isOver = ema > budget * overFactor;
      if (since < 0 || isOver !== over) {
        over = isOver;
        since = nowMs;
        return q.scale;
      }
      const elapsed = nowMs - since;
      if (over && elapsed >= lowerAfter && q.scale > min) {
        q.scale = round(Math.max(min, q.scale - step));
        since = nowMs;
      } else if (!over && elapsed >= raiseAfter && q.scale < max) {
        q.scale = round(Math.min(max, q.scale + step));
        since = nowMs;
      }
      return q.scale;
    },
    /** Back to max with fresh timers (quality mode or budget changed). */
    reset() {
      q.scale = max;
      ema = -1;
      since = -1;
    },
    /** @param {number} m new ceiling (e.g. renderScaleMax from the shell) */
    setMax(m) {
      max = m;
      if (q.scale > max || !q.enabled) q.scale = max;
    },
    /** @param {number} ms new frame budget (e.g. fps cap changed) */
    setBudget(ms) {
      budget = ms;
    },
  };
  return q;
}
