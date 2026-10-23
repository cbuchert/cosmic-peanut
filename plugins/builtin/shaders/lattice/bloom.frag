#version 300 es
// Lattice family — the cinematic look's bloom chain (lib/lattice-bloom.js), after Jimenez, "Next
// Generation Post Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014 Advances course).
//   (default) 13-tap downsample: five overlapping 2 × 2 boxes read with bilinear taps — the centre
//             box weighted 0.5, the four corner boxes 0.125 each — which doesn't alias the way a
//             single 2 × 2 box does as the image moves.
//   KARIS     the first downsample: each box weighted by 1 / (1 + luma) (the Karis average), so a
//             lone very bright pixel can't swell into a flickering blob.
//   UP        3 × 3 tent upsample of the smaller level (added onto the larger one by blending).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_src;
uniform vec2 u_texel; // 1 / the source's size

vec3 tap(vec2 off) {
  return max(texture(u_src, v_uv + off * u_texel).rgb, 0.0);
}

#ifdef UP
void main() {
  vec3 s = 4.0 * tap(vec2(0.0)) +
           2.0 * (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) +
           tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  o = vec4(s / 16.0, 1.0);
}
#else
float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// A box's weight: its share (0.5 centre, 0.125 corners), Karis-averaged on the first level.
float boxWeight(vec3 box, float share) {
#ifdef KARIS
  return share / (1.0 + luma(box));
#else
  return share;
#endif
}

void main() {
  vec3 a = tap(vec2(-2.0, -2.0));
  vec3 b = tap(vec2(0.0, -2.0));
  vec3 c = tap(vec2(2.0, -2.0));
  vec3 d = tap(vec2(-1.0, -1.0));
  vec3 e = tap(vec2(1.0, -1.0));
  vec3 f = tap(vec2(-2.0, 0.0));
  vec3 g = tap(vec2(0.0, 0.0));
  vec3 h = tap(vec2(2.0, 0.0));
  vec3 i = tap(vec2(-1.0, 1.0));
  vec3 j = tap(vec2(1.0, 1.0));
  vec3 k = tap(vec2(-2.0, 2.0));
  vec3 l = tap(vec2(0.0, 2.0));
  vec3 m = tap(vec2(2.0, 2.0));
  vec3 centre = (d + e + i + j) * 0.25;
  vec3 tl = (a + b + f + g) * 0.25;
  vec3 tr = (b + c + g + h) * 0.25;
  vec3 bl = (f + g + k + l) * 0.25;
  vec3 br = (g + h + l + m) * 0.25;
  float w0 = boxWeight(centre, 0.5);
  float w1 = boxWeight(tl, 0.125);
  float w2 = boxWeight(tr, 0.125);
  float w3 = boxWeight(bl, 0.125);
  float w4 = boxWeight(br, 0.125);
  o = vec4((centre * w0 + tl * w1 + tr * w2 + bl * w3 + br * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
}
#endif
