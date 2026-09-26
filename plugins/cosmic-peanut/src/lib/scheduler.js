// @ts-check
/** Fixed-rate ring push clock (PRD "Ring history"). */

/**
 * Rings are pushed at a fixed rate (N ÷ travel per second) driven by a `dt` accumulator, not once
 * per display frame, so travel time is exact at any refresh rate. `frac` (0–1) is the leftover
 * fraction of a push interval; the shader adds it to each ring's age so rings glide between pushes.
 */
export function createPushScheduler() {
  return {
    /** Leftover fraction of a push interval, 0–1. */
    frac: 0,
    /**
     * Advance the clock; returns how many rings to push now.
     * @param {number} dt seconds
     * @param {number} rate rings per second
     */
    step(dt, rate) {
      const clock = this.frac + dt * rate;
      const n = Math.floor(clock);
      this.frac = clock - n;
      return n;
    },
    reset() {
      this.frac = 0;
    },
  };
}
