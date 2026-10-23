// @ts-check
/**
 * Möbius's snake: the ribbon covers part of a closed track and its head advances along it. Each
 * slice is placed where the head was when it was pushed and stays there, so older slices trail
 * behind and nothing slides. Places are fractions of the track (0–1), so they survive a Track
 * change. Nothing is allocated per step.
 */

/** Extra head speed on the beat, per unit of envelope × Beat (gentle: the envelope eases). */
export const SURGE = 0.3;

/**
 * Head speed in track fractions per second: Length of the track per Travel time, plus the surge.
 * @param {number} length the Length param (fraction of the track the snake covers)
 * @param {number} travel the Travel time param, seconds from head to tail
 * @param {number} env createBeat's `env` @param {number} beat the Beat param (after `gentle`)
 */
export function headSpeed(length, travel, env, beat) {
  return (length / travel) * (1 + SURGE * env * beat);
}

/** @param {number} x */
const wrap = (x) => x - Math.floor(x);

/** @param {number} N rings alive */
export function createSnake(N) {
  const s = {
    /** Head position, fraction of the track. */
    head: 0,
    /** Each history row's place on the track (fraction), uploaded as the `uPos` texture. */
    pos: new Float32Array(N),
    /** @param {number} dt seconds @param {number} speed from {@link headSpeed} */
    step(dt, speed) {
      s.head = wrap(s.head + speed * dt);
    },
    /**
     * Place the slice just pushed into `row`, whose push was due `ago` seconds before now.
     * @param {number} row @param {number} ago seconds @param {number} speed current head speed
     */
    place(row, ago, speed) {
      s.pos[row] = wrap(s.head - speed * ago);
    },
    /** New density: the history restarts, so do the places. @param {number} n */
    resize(n) {
      s.pos = new Float32Array(n);
    },
  };
  return s;
}
