// Shared by sim.frag (bake) and composite.frag (display); spliced in at "#include events.glsl",
// after sample.glsl.
//
// The page as it is now = the baked ink texture pushed through the pending events. For a point,
// walk the events newest → oldest through their exact inverse maps to find where its paint was
// at the last bake; a point inside a drop takes that drop's ink instead (antialiased over one
// texel). Mirrors dropInverse / dragInverse in src/lib/marbling.js.
// Ink texture channels: amounts of inks 0–3 (paper = 1 − their sum).

const int MAX_PENDING = 48;
const int DRAG_ITERS = 7;
uniform int u_n;
uniform vec4 u_a[MAX_PENDING];   // (type, x, y, R² | 1/σ² | 0)
uniform vec4 u_b[MAX_PENDING];   // drop: (cell r², ...); drag: (vx, vy, ...)
uniform vec4 u_c[MAX_PENDING];   // drop: cell ink
uniform vec4 u_d[MAX_PENDING];   // drop: rim ink

// p: page units (height 1). Returns ink amounts.
vec4 marble(vec2 p) {
  float H = u_prevSize.y;          // page units → texels
  vec4 acc = vec4(0.0);
  float T = 1.0;                    // share of the point not yet covered by a newer drop
  for (int k = MAX_PENDING - 1; k >= 0; k--) {
    if (k >= u_n) continue;
    vec4 a = u_a[k];
    if (a.x < 1.5) {                // DROP
      vec2 d = p - a.yz;
      float q = dot(d, d);
      float dist = sqrt(q);
      float w = clamp((sqrt(a.w) - dist) * H + 0.5, 0.0, 1.0);
      if (w > 0.0) {
        // No rim in this slice (cell r² = R²): all cell ink, even on the antialiased edge.
        float wc = u_b[k].x >= a.w ? 1.0 : clamp((sqrt(u_b[k].x) - dist) * H + 0.5, 0.0, 1.0);
        acc += T * w * mix(u_d[k], u_c[k], wc);
        T *= 1.0 - w;
        if (T <= 0.0) return acc;
      }
      p = a.yz + d * sqrt(max(0.0, 1.0 - a.w / max(q, a.w)));
    } else if (a.x < 2.5) {         // DRAG (fixed-point inverse)
      vec2 v = u_b[k].xy;
      vec2 p0 = p;
      for (int i = 0; i < DRAG_ITERS; i++) {
        vec2 d = p - a.yz;
        p = p0 - v * exp(-dot(d, d) * a.w);
      }
    } else {                        // SHIFT
      p -= a.yz;
    }
  }
  return acc + T * sampleInk(p * H);
}
