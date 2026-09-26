// @ts-check
/** Static ring grid (PRD "Geometry"). */

/** Primitive-restart index for UNSIGNED_INT indices (always on in WebGL2). */
export const RESTART = 0xffffffff;

/**
 * Vertex attribute (j, i) for every point j = 0…M of every ring i = 0…N−1 (j = M repeats point 0
 * so the strip closes), and LINE_STRIP indices with a restart between rings. Built once per
 * density; everything else comes from uniforms and the history texture.
 * @param {number} N rings
 * @param {number} M points per ring
 */
export function buildGrid(N, M) {
  const verts = new Float32Array(N * (M + 1) * 2);
  const indices = new Uint32Array(N * (M + 2));
  let v = 0;
  let k = 0;
  for (let i = 0; i < N; i++) {
    const base = i * (M + 1);
    for (let j = 0; j <= M; j++) {
      verts[v++] = j;
      verts[v++] = i;
      indices[k++] = base + j;
    }
    indices[k++] = RESTART;
  }
  return { verts, indices };
}
