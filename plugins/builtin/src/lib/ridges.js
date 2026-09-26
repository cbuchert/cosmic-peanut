// @ts-check
/**
 * Ridge-line math for Pulsar (the Unknown Pleasures plot). Pure functions over preallocated
 * typed arrays; nothing here allocates after setup.
 */

/**
 * Fill `out` with a raised-cosine bump centred on the middle of the line.
 * @param {Float32Array} out one value per point, x from 0 to 1
 * @param {number} halfWidth half the bump's width, as a fraction of the line
 */
export function centralEnvelope(out, halfWidth) {
  const last = out.length - 1;
  for (let i = 0; i <= last; i++) {
    const d = Math.abs(i / last - 0.5) / halfWidth;
    out[i] = d < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * d) : 0;
  }
}

/**
 * Band level at a fractional band index, linearly interpolated and clamped to the ends.
 * @param {ArrayLike<number>} bands
 * @param {number} pos
 */
export function bandAt(bands, pos) {
  const last = bands.length - 1;
  if (pos <= 0) return bands[0];
  if (pos >= last) return bands[last];
  const i = Math.floor(pos);
  const f = pos - i;
  return bands[i] + (bands[i + 1] - bands[i]) * f;
}

/**
 * Advance the scroll by `dt`: returns how many whole lines to push now and leaves the leftover
 * fraction of a line in `state.frac` (0 ≤ frac < 1) so drawing can offset by it.
 * @param {{ frac: number }} state
 * @param {number} dt seconds
 * @param {number} rate lines per second
 * @param {number} max cap on lines per call (the history length)
 */
export function advanceScroll(state, dt, rate, max) {
  const acc = state.frac + dt * rate;
  const n = Math.floor(acc);
  state.frac = acc - n;
  return n < max ? n : max;
}

/**
 * History of `lines` rows of `points` values in one preallocated buffer.
 * @param {number} lines
 * @param {number} points
 */
export function createRing(lines, points) {
  return { data: new Float32Array(lines * points), lines, points, head: 0 };
}

/**
 * Make room for a new newest row and return its offset into `ring.data` (the caller fills it).
 * @param {ReturnType<typeof createRing>} ring
 */
export function ringPush(ring) {
  ring.head = (ring.head + 1) % ring.lines;
  return ring.head * ring.points;
}

/**
 * Offset of the row `age` pushes old (0 = newest).
 * @param {ReturnType<typeof createRing>} ring
 * @param {number} age 0 … lines − 1
 */
export function ringRow(ring, age) {
  return ((ring.head - age + ring.lines) % ring.lines) * ring.points;
}

/**
 * A new ring of `lines` rows holding the newest rows of `ring` (not for use per frame).
 * @param {ReturnType<typeof createRing>} ring
 * @param {number} lines
 */
export function resizeRing(ring, lines) {
  const next = createRing(lines, ring.points);
  const keep = Math.min(lines, ring.lines);
  // Oldest kept row first, so the newest ends up at the head.
  for (let age = keep - 1; age >= 0; age--) {
    const from = ringRow(ring, age);
    next.data.set(ring.data.subarray(from, from + ring.points), ringPush(next));
  }
  return next;
}
