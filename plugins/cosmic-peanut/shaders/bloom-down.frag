#version 300 es
// Bloom downsample (Jorge Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
// Warfare", SIGGRAPH 2014; src/lib/bloom.js): 13 bilinear taps forming five overlapping 2×2-texel
// boxes, the centre box weighted 0.5 and the four corner boxes 0.125 each. With uKaris (the first
// downsample only) each box is weighted by 1 / (1 + luma), Karis's average, so isolated very bright
// pixels can't flicker into blobs.
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;           // source texel size
uniform float uKaris;
out vec4 o;

vec3 tap(float x, float y) {
  return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb;
}

float karis(vec3 c) {
  return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
}

void main() {
  vec3 a = tap(-2.0, 2.0), b = tap(0.0, 2.0), c = tap(2.0, 2.0);
  vec3 d = tap(-2.0, 0.0), e = tap(0.0, 0.0), f = tap(2.0, 0.0);
  vec3 g = tap(-2.0, -2.0), h = tap(0.0, -2.0), i = tap(2.0, -2.0);
  vec3 j = tap(-1.0, 1.0), k = tap(1.0, 1.0), l = tap(-1.0, -1.0), m = tap(1.0, -1.0);
  vec3 b0 = (j + k + l + m) * 0.25;
  vec3 b1 = (a + b + d + e) * 0.25;
  vec3 b2 = (b + c + e + f) * 0.25;
  vec3 b3 = (d + e + g + h) * 0.25;
  vec3 b4 = (e + f + h + i) * 0.25;
  vec4 w = vec4(0.125);
  float w0 = 0.5;
  if (uKaris > 0.5) {
    w0 *= karis(b0);
    w *= vec4(karis(b1), karis(b2), karis(b3), karis(b4));
  }
  vec3 sum = b0 * w0 + b1 * w.x + b2 * w.y + b3 * w.z + b4 * w.w;
  o = vec4(sum / (w0 + w.x + w.y + w.z + w.w), 0.0);
}
