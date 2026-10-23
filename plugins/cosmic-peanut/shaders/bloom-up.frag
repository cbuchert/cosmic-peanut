#version 300 es
// Bloom upsample (Jimenez 2014; src/lib/bloom.js): a 3×3 tent over the smaller mip, added onto the
// larger one by the blend (ONE, ONE).
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;           // source (smaller mip) texel size
out vec4 o;

vec3 tap(float x, float y) {
  return texture(uSrc, vUv + vec2(x, y) * uTexel).rgb;
}

void main() {
  vec3 s = tap(0.0, 0.0) * 4.0;
  s += (tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, -1.0) + tap(0.0, 1.0)) * 2.0;
  s += tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0);
  o = vec4(s / 16.0, 0.0);
}
