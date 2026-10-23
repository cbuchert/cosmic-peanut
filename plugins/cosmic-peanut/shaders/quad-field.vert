#version 300 es
// Cinematic Möbius Field: field.vert's bands as prefiltered line quads (quad.glsl), with depth of
// field. A slice's frame is shared by its points; the neighbours cost a texel fetch each.
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: 2·point + side (point 0..M/uStride), y: slice (0 = newest)
in vec4 aOff;
in vec4 aRot;
in vec4 aBand;
uniform sampler2D uHist;
uniform sampler2D uPos;
uniform int uHead, uN, uM, uStride, uSlices;
uniform float uFrac, uAmp, uWidth, uTwist;
uniform mat4 uProj, uView;
out float vAge, vSample, vEmpty, vFade, vHue;
//#include quad

vec3 rotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int i = int(aIdx.y);
  int x = int(aIdx.x);
  int jx = x >> 1;
  float side = float(x & 1) * 2.0 - 1.0;
  int row = (uHead - i - int(aBand.y) + 2 * uN) % uN;
  float size = texelFetch(uPos, ivec2(row, 0), 0).g;

  float slot = float(i) + uFrac;
  float u = -12.56637061 * slot / float(uSlices);
  vec3 c = vec3(cos(u), 0.0, sin(u));
  vec3 t = vec3(-sin(u), 0.0, cos(u));
  vec3 w = cos(0.5 * u) * c + vec3(0.0, sin(0.5 * u), 0.0);
  float phi = uTwist * aBand.w;
  vec3 ww = cos(phi) * w + sin(phi) * cross(t, w);
  vec3 n = cross(t, ww);

  int last = uM / uStride;
  vec4 e[3];
  float s = 0.0;
  float empty = 0.0;
  for (int k = 0; k < 3; k++) {
    int j = clamp(jx + k - 1, 0, last) * uStride;
    float sk = texelFetch(uHist, ivec2(j % uM, row), 0).r;
    float ek = step(1e5, sk);
    sk *= 1.0 - ek;
    float v = (float(j) / float(uM) * 2.0 - 1.0) * uWidth;
    vec3 local = c + size * (v * ww + uAmp * sk * n);
    e[k] = uView * vec4(aOff.xyz + aBand.x * rotate(aRot, local), 1.0);
    if (k == 1) {
      s = sk;
      empty = ek;
    }
  }
  vAge = slot / float(uSlices - 1);
  vSample = s;
  vEmpty = empty;
  vFade = aOff.w;
  vHue = aBand.z;
  gl_Position = lineVertex(e[1], e[0], e[2], side);
}
