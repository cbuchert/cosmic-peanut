// @ts-check
/**
 * Render-loop instrumentation. Fixed-size rings of the newest samples; no per-frame allocation
 * (the only allocation is the report object, once per second).
 */

/**
 * Nearest-rank percentile of the first `n` entries of an ascending-sorted array.
 * @param {Float64Array} sorted
 * @param {number} n
 * @param {number} p 0–1
 */
export function percentile(sorted, n, p) {
  if (n <= 0) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
}

/**
 * @typedef {{ fps: number, frameMsP50: number, frameMsP99: number, pluginMsP50: number,
 *   sdkMsP50: number, dropped: number }} PerfReport
 */

/**
 * @param {{ expectedIntervalMs: number, capacity?: number, periodMs?: number }} o
 */
export function createPerfMeter(o) {
  const cap = o.capacity ?? 256;
  const period = o.periodMs ?? 1000;
  let expected = o.expectedIntervalMs;
  const frameMs = new Float64Array(cap), pluginMs = new Float64Array(cap), sdkMs = new Float64Array(cap);
  const scratch = new Float64Array(cap);
  let head = 0, count = 0, frames = 0, dropped = 0, windowStart = 0;

  /** Sort the first `count` ring entries of `ring` into scratch and take percentile p. */
  function pct(/** @type {Float64Array} */ ring, /** @type {number} */ p) {
    // Valid samples are ring[0..count) (head restarts at 0 each window); order is irrelevant.
    scratch.set(ring);
    for (let i = count; i < cap; i++) scratch[i] = Infinity;
    scratch.sort();
    return percentile(scratch, count, p);
  }

  return {
    /** @param {number} nowMs start of the first window */
    start(nowMs) {
      windowStart = nowMs;
      head = count = frames = dropped = 0;
    },
    /** @param {number} ms expected display interval (1000 / fps target) */
    setExpectedInterval(ms) {
      expected = ms;
    },
    /**
     * Record one rendered frame.
     * @param {number} intervalMs time since the previous rendered frame
     * @param {number} plugin plugin `frame` CPU time (ms)
     * @param {number} sdk SDK time in the rAF callback excluding the plugin (ms)
     */
    frame(intervalMs, plugin, sdk) {
      frameMs[head] = intervalMs;
      pluginMs[head] = plugin;
      sdkMs[head] = sdk;
      head = (head + 1) % cap;
      if (count < cap) count++;
      frames++;
      const missed = Math.round(intervalMs / expected) - 1;
      if (missed > 0) dropped += missed;
    },
    /**
     * @param {number} nowMs
     * @returns {PerfReport | null} a report once per period, else null
     */
    report(nowMs) {
      const elapsed = nowMs - windowStart;
      if (elapsed < period) return null;
      /** @type {PerfReport} */
      const r = {
        fps: (frames * 1000) / elapsed,
        frameMsP50: pct(frameMs, 0.5),
        frameMsP99: pct(frameMs, 0.99),
        pluginMsP50: pct(pluginMs, 0.5),
        sdkMsP50: pct(sdkMs, 0.5),
        dropped,
      };
      windowStart = nowMs;
      head = count = frames = dropped = 0;
      return r;
    },
  };
}
