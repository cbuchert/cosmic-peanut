#version 300 es
// Cinematic Cosmic Peanut: rings.vert's sphere of rings as prefiltered line quads (quad.glsl). The
// same placement for point j of ring i, evaluated for j and its two neighbours around the ring.
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: 2·point + side (point 0..M, M closes the ring), y: ring age index
uniform sampler2D uHist;
uniform int uHead, uN, uM;
uniform float uFrac, uAmp, uRadius, uPulse;
uniform mat4 uProj, uView;
out float vAge, vDepth, vSample, vEmpty;
//#include quad

vec4 ringPoint(int j, int row, float theta, out float s, out float empty) {
  s = texelFetch(uHist, ivec2((j % uM + uM) % uM, row), 0).r;
  empty = step(1e5, s);
  s *= 1.0 - empty;
  float phi = float(j) / float(uM) * 6.28318531;
  float r = (uRadius + uAmp * s) * (1.0 + uPulse * 0.06);
  return uView * vec4(r * vec3(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi)), 1.0);
}

void main() {
  int i = int(aIdx.y);
  int x = int(aIdx.x);
  int j = x >> 1;
  float side = float(x & 1) * 2.0 - 1.0;
  int row = (uHead - i + uN) % uN;
  float age = (float(i) + uFrac) / float(uN - 1);
  float theta = clamp(age, 0.0, 1.0) * 3.14159265;
  float s, empty, s0, e0;
  vec4 e = ringPoint(j, row, theta, s, empty);
  vec4 ep = ringPoint(j - 1, row, theta, s0, e0);
  vec4 en = ringPoint(j + 1, row, theta, s0, e0);
  vAge = age;
  vDepth = -e.z;
  vSample = s;
  vEmpty = empty;
  gl_Position = lineVertex(e, ep, en, side);
}
