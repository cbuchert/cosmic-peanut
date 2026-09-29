// Shared by sim.frag and resample.frag (spliced in at "#include sample.glsl").
//
// Sharp resampling of the ink texture. Every frame with a pour moves (almost) every pixel by a
// fraction of a texel, so the page is resampled hundreds of times: bilinear filtering would blur
// the veins away within seconds. Instead:
//  1. Catmull-Rom bicubic from the 4×4 texels around the point (texelFetch, no filtering),
//  2. clamped to the min/max of the 2×2 texels around it (no ringing / overshoot),
//  3. re-steepened by a power-and-renormalise of the ink shares, by as much as this sample blurred
//     (the resampling blur is ~f(1−f) per axis; an integer shift is an exact copy and gets none).
// Outside the texture is clear paper (0).
uniform sampler2D u_prev;
uniform vec2 u_prevSize;   // texels
uniform float u_sharp;     // anti-diffusion strength

vec4 inkAt(ivec2 i) {
  if (any(lessThan(i, ivec2(0))) || any(greaterThanEqual(i, ivec2(u_prevSize)))) return vec4(0.0);
  return texelFetch(u_prev, i, 0);
}

// Catmull-Rom weights for fraction f.
vec4 crWeights(float f) {
  return vec4(
    f * (-0.5 + f * (1.0 - 0.5 * f)),
    1.0 + f * f * (-2.5 + 1.5 * f),
    f * (0.5 + f * (2.0 - 1.5 * f)),
    f * f * (-0.5 + 0.5 * f));
}

// px: position in texels (texel centres at i + 0.5).
vec4 sampleInk(vec2 px) {
  vec2 t = px - 0.5;
  vec2 i0 = floor(t);
  if (any(lessThan(i0, vec2(-3.0))) || any(greaterThan(i0, u_prevSize + 2.0))) return vec4(0.0);
  vec2 f = t - i0;
  if (f == vec2(0.0)) return inkAt(ivec2(i0));   // on a texel centre: exact copy
  ivec2 b = ivec2(i0) - 1;
  vec4 wx = crWeights(f.x);
  vec4 wy = crWeights(f.y);
  vec4 T[16];
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) T[j * 4 + i] = inkAt(b + ivec2(i, j));
  vec4 v = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 row = T[j * 4] * wx.x + T[j * 4 + 1] * wx.y + T[j * 4 + 2] * wx.z + T[j * 4 + 3] * wx.w;
    v += row * wy[j];
  }
  vec4 a = T[5], c = T[6], d = T[9], e = T[10];
  vec4 lo = min(min(a, c), min(d, e));
  vec4 hi = max(max(a, c), max(d, e));
  v = clamp(v, lo, hi);
  // Re-steepen the edges the resampling just softened: raise the five shares (four inks and the
  // paper) to a power γ ≥ 1 and renormalise. Where two shares are equal they stay equal, so every
  // boundary stays exactly where it was (no drift, no facets, no paper leaking into junctions);
  // only the transition across it narrows. γ − 1 scales with the blur this sample added.
  float g = 1.0 + u_sharp * 2.0 * (f.x * (1.0 - f.x) + f.y * (1.0 - f.y));
  float paper = max(0.0, 1.0 - (v.x + v.y + v.z + v.w));
  vec4 wv = pow(max(v, vec4(0.0)), vec4(g));
  float wp = pow(paper, g);
  float n = wv.x + wv.y + wv.z + wv.w + wp;
  return n > 0.0 ? wv / n : v;
}
