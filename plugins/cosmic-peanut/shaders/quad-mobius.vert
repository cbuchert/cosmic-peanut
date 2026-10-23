#version 300 es
// Cinematic Möbius: mobius.vert's slices as prefiltered line quads (quad.glsl). Everything about a
// slice's place on the track is shared by its points; only the waveform sample and the position
// across the strip differ, so the two neighbours cost a texel fetch each.
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: 2·point + side (point 0..M across the strip), y: ring age index
uniform sampler2D uHist;
uniform sampler2D uTrack;
uniform sampler2D uPos;
uniform int uHead, uN, uM;
uniform float uFrac, uAmp, uWidth, uTwist;
uniform mat4 uProj, uView;
out float vAge, vDepth, vSample, vEmpty;
//#include quad

vec3 at(int r, int k0, int k1, float a) {
  return mix(texelFetch(uTrack, ivec2(k0, r), 0).xyz, texelFetch(uTrack, ivec2(k1, r), 0).xyz, a);
}

void main() {
  int i = int(aIdx.y);
  int x = int(aIdx.x);
  int jx = x >> 1;
  float side = float(x & 1) * 2.0 - 1.0;
  int row = (uHead - i + uN) % uN;
  float age = (float(i) + uFrac) / float(uN - 1);

  int K = textureSize(uTrack, 0).x;
  vec2 placed = texelFetch(uPos, ivec2(row, 0), 0).rg;
  float f = placed.r * float(K);
  float fl = floor(f);
  int k0 = int(fl) % K;
  int k1 = (k0 + 1) % K;
  float a = f - fl;
  vec3 c = at(0, k0, k1, a);
  vec3 t = normalize(at(1, k0, k1, a));
  vec3 w = at(2, k0, k1, a);
  w = normalize(w - dot(w, t) * t);
  vec3 b = cross(t, w);
  vec3 ww = cos(uTwist) * w + sin(uTwist) * b;
  vec3 n = cross(t, ww);

  vec4 e[3];
  float s = 0.0;
  float empty = 0.0;
  for (int k = 0; k < 3; k++) {
    int jj = clamp(jx + k - 1, 0, uM);
    float sk = texelFetch(uHist, ivec2(jj % uM, row), 0).r;
    float ek = step(1e5, sk);
    sk *= 1.0 - ek;
    float v = (float(jj) / float(uM) * 2.0 - 1.0) * uWidth;
    e[k] = uView * vec4(c + placed.g * (v * ww + uAmp * sk * n), 1.0);
    if (k == 1) {
      s = sk;
      empty = ek;
    }
  }
  vAge = age;
  vDepth = -e[1].z;
  vSample = s;
  vEmpty = empty;
  gl_Position = lineVertex(e[1], e[0], e[2], side);
}
