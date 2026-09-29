// @ts-check
/**
 * Hyperbolic geometry for Tentacube's background, mirrored by shaders/tentacube/hyperbolic.glsl:
 * disk isometries (Möbius and anti-Möbius maps), the {p,q} triangle-group fold into the
 * fundamental domain, and the drifting, rebased view transform.
 *
 * An isometry is a Float64Array(9) [ar, ai, br, bi, cr, ci, dr, di, conj]:
 *   T(z) = (a·z' + b) / (c·z' + d),  z' = conj ? z̄ : z.
 */

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0];

export function createIsometry() {
  return Float64Array.from(IDENTITY);
}

/**
 * out = T(x + iy).
 * @param {Float64Array} m @param {number} x @param {number} y @param {Float64Array} out
 */
export function mobiusApply(m, x, y, out) {
  if (m[8]) y = -y;
  const nr = m[0] * x - m[1] * y + m[2];
  const ni = m[0] * y + m[1] * x + m[3];
  const dr = m[4] * x - m[5] * y + m[6];
  const di = m[4] * y + m[5] * x + m[7];
  const q = dr * dr + di * di;
  out[0] = (nr * dr + ni * di) / q;
  out[1] = (ni * dr - nr * di) / q;
  return out;
}

const tmp = new Float64Array(9);

/**
 * out = m1 ∘ m2 (m2 applied first); out may alias either. The matrix is rescaled to |det| = 1.
 * (A, a) ∘ (B, b) = (A · (a ? B̄ : B), a xor b).
 * @param {Float64Array} out @param {Float64Array} m1 @param {Float64Array} m2
 */
export function mobiusCompose(out, m1, m2) {
  const s = m1[8] ? -1 : 1; // conjugate m2's entries if m1 conjugates its input
  const b0 = m2[0], b1 = s * m2[1], b2 = m2[2], b3 = s * m2[3];
  const b4 = m2[4], b5 = s * m2[5], b6 = m2[6], b7 = s * m2[7];
  const a0 = m1[0], a1 = m1[1], a2 = m1[2], a3 = m1[3];
  const a4 = m1[4], a5 = m1[5], a6 = m1[6], a7 = m1[7];
  // [a b; c d] · [e f; g h]
  tmp[0] = a0 * b0 - a1 * b1 + a2 * b4 - a3 * b5;
  tmp[1] = a0 * b1 + a1 * b0 + a2 * b5 + a3 * b4;
  tmp[2] = a0 * b2 - a1 * b3 + a2 * b6 - a3 * b7;
  tmp[3] = a0 * b3 + a1 * b2 + a2 * b7 + a3 * b6;
  tmp[4] = a4 * b0 - a5 * b1 + a6 * b4 - a7 * b5;
  tmp[5] = a4 * b1 + a5 * b0 + a6 * b5 + a7 * b4;
  tmp[6] = a4 * b2 - a5 * b3 + a6 * b6 - a7 * b7;
  tmp[7] = a4 * b3 + a5 * b2 + a6 * b7 + a7 * b6;
  tmp[8] = m1[8] !== m2[8] ? 1 : 0;
  // det = ad − bc
  const dr = tmp[0] * tmp[6] - tmp[1] * tmp[7] - (tmp[2] * tmp[4] - tmp[3] * tmp[5]);
  const di = tmp[0] * tmp[7] + tmp[1] * tmp[6] - (tmp[2] * tmp[5] + tmp[3] * tmp[4]);
  const k = 1 / Math.sqrt(Math.hypot(dr, di));
  for (let i = 0; i < 8; i++) out[i] = tmp[i] * k;
  out[8] = tmp[8];
  return out;
}

/**
 * out = the hyperbolic translation z ↦ (z + t) / (t̄ z + 1), which sends 0 to t (|t| < 1).
 * @param {Float64Array} out @param {number} tx @param {number} ty
 */
export function mobiusTranslate(out, tx, ty) {
  const k = 1 / Math.sqrt(1 - tx * tx - ty * ty);
  out[0] = k;
  out[1] = 0;
  out[2] = tx * k;
  out[3] = ty * k;
  out[4] = tx * k;
  out[5] = -ty * k;
  out[6] = k;
  out[7] = 0;
  out[8] = 0;
  return out;
}

/**
 * out = rotation about the origin, z ↦ e^{iθ} z.
 * @param {Float64Array} out @param {number} angle
 */
export function mobiusRotate(out, angle) {
  out[0] = Math.cos(angle / 2);
  out[1] = Math.sin(angle / 2);
  out[2] = out[3] = out[4] = out[5] = 0;
  out[6] = Math.cos(angle / 2);
  out[7] = -Math.sin(angle / 2);
  out[8] = 0;
  return out;
}

/**
 * Hyperbolic distance between two points of the Poincaré disk.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 */
export function hypDist(x1, y1, x2, y2) {
  // |z1 − z2| / |1 − z̄1 z2|
  const nr = x1 - x2;
  const ni = y1 - y2;
  const dr = 1 - (x1 * x2 + y1 * y2);
  const di = -(x1 * y2 - y1 * x2);
  return 2 * Math.atanh(Math.hypot(nr, ni) / Math.hypot(dr, di));
}

/**
 * The {p,q} triangle group's fundamental triangle (angles π/p at the origin, π/2, π/q): the sector
 * 0 ≤ arg z ≤ α = π/p, cut off by the geodesic circle C (centre (cx, 0), radius r, orthogonal to
 * the rim). A tile is the regular p-gon of 2p such triangles around the origin. Needs
 * 1/p + 1/q < 1/2.
 * @param {number} p @param {number} q
 * @returns {{ p: number, q: number, alpha: number, cx: number, r: number }}
 */
export function tiling(p, q) {
  const alpha = Math.PI / p;
  const sa = Math.sin(alpha);
  const cb = Math.cos(Math.PI / q);
  const k = Math.sqrt(cb * cb - sa * sa);
  return { p, q, alpha, cx: cb / k, r: sa / k };
}

/** Max reflection rounds; plenty for |z| < 0.9999. */
export const FOLD_ITERATIONS = 60;

const step = new Float64Array(9);

/**
 * Reflect z into the fundamental domain: rotate into the sector [0, 2α), mirror into [0, α],
 * invert in C if inside it, repeat. out = [x, y, number of circle inversions] (the tile's
 * "generation", used for colour). With `g`, also accumulate the isometry that was applied.
 * @param {number} x @param {number} y @param {ReturnType<typeof tiling>} t @param {Float64Array} out
 * @param {Float64Array | null} [g]
 */
export function fold(x, y, t, out, g = null) {
  const a2 = 2 * t.alpha;
  const r2 = t.r * t.r;
  let n = 0;
  if (g) g.set(IDENTITY);
  for (let i = 0; i < FOLD_ITERATIONS; i++) {
    const ang = Math.atan2(y, x);
    const k = Math.floor(ang / a2);
    if (k !== 0) {
      const c = Math.cos(-k * a2);
      const s = Math.sin(-k * a2);
      const nx = x * c - y * s;
      y = x * s + y * c;
      x = nx;
      if (g) mobiusCompose(g, mobiusRotate(step, -k * a2), g);
    }
    if (Math.atan2(y, x) > t.alpha) {
      // Mirror in the line at angle α: z ↦ e^{2iα} z̄.
      const c = Math.cos(a2);
      const s = Math.sin(a2);
      const nx = x * c + y * s;
      y = x * s - y * c;
      x = nx;
      if (g) {
        step.set(IDENTITY);
        step[0] = Math.cos(t.alpha);
        step[1] = Math.sin(t.alpha);
        step[6] = Math.cos(t.alpha);
        step[7] = -Math.sin(t.alpha);
        step[8] = 1;
        mobiusCompose(g, step, g);
      }
    }
    const dx = x - t.cx;
    const d2 = dx * dx + y * y;
    if (d2 >= r2) break;
    // Invert in C: z ↦ cx + r² / (z̄ − cx) = (cx z̄ + r² − cx²) / (z̄ − cx).
    x = t.cx + (r2 * dx) / d2;
    y = (r2 * y) / d2;
    n++;
    if (g) {
      step[0] = t.cx;
      step[1] = 0;
      step[2] = r2 - t.cx * t.cx;
      step[3] = 0;
      step[4] = 1;
      step[5] = 0;
      step[6] = -t.cx;
      step[7] = 0;
      step[8] = 1;
      mobiusCompose(g, step, g);
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = n;
  return out;
}

const scratch = new Float64Array(3);

/**
 * The tiling-group element g that `fold` applies to (x, y): g(x, y) is in the fundamental domain.
 * @param {number} x @param {number} y @param {ReturnType<typeof tiling>} t @param {Float64Array} g
 */
export function foldElement(x, y, t, g) {
  fold(x, y, t, scratch, g);
  return g;
}

/**
 * The background's view transform T (screen disk → tiling), drifting through hyperbolic space:
 * each step composes a small translation along a slowly turning heading on the screen side
 * (T ← T ∘ E), then rebases — T ← g ∘ T with g the tiling symmetry that folds T(0) back into the
 * fundamental domain — which leaves the picture unchanged (the tiling is g-invariant) but keeps
 * the coefficients small enough for float32 in the shader, however far it travels.
 * @param {ReturnType<typeof tiling>} t
 */
export function createDrift(t) {
  const e = createIsometry();
  const g = createIsometry();
  const c = new Float64Array(2);
  return {
    m: createIsometry(),
    heading: 0,
    tiling: t,
    /**
     * @param {number} dt @param {number} speed hyperbolic distance per second
     * @param {number} turn heading change (rad/s)
     */
    advance(dt, speed, turn) {
      this.heading += turn * dt;
      const r = Math.tanh((speed * dt) / 2); // |t| for hyperbolic distance speed·dt from 0
      mobiusTranslate(e, r * Math.cos(this.heading), r * Math.sin(this.heading));
      mobiusCompose(this.m, this.m, e);
    },
    rebase() {
      mobiusApply(this.m, 0, 0, c);
      foldElement(c[0], c[1], this.tiling, g);
      mobiusCompose(this.m, g, this.m);
    },
    /** @param {number} dt @param {number} speed @param {number} turn */
    step(dt, speed, turn) {
      this.advance(dt, speed, turn);
      this.rebase();
    },
  };
}
