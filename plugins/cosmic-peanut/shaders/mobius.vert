#version 300 es
// Möbius: one vertex per (point j, ring i), like rings.vert, but each ring is an open slice across
// the strip's width (v = −W..W as j = 0..M) lying on a closed track (src/lib/track.js). The rings
// snake: each row was placed on the track where the head was when it was pushed (uPos, a fraction
// of the track; src/lib/snake.js), so slices stay put while the head moves on and the tail fades.
// uTrack holds, evenly in arc length, the centre line, its unit tangent t and the cross-section
// direction w with the track's twist already in it (loop: half a turn per lap; figure-8: half a
// turn one way over one lobe, back over the other). On the beat (src/lib/beat.js) the strip
// wrings — w turns about t by uTwist, the one frame-wide beat effect (a roll, not a size). The
// waveform pushes along the surface normal t × w. Size is per slice: uPos.g holds the scale it
// was laid at (beat breath × bass swell), so nothing already on the strip grows on a beat.
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: point across the strip (0..M), y: ring age index (0 = newest)
uniform sampler2D uHist;       // M x N waveform history, circular in rows
uniform sampler2D uTrack;      // K x 3 RGBA32F: centre, tangent, cross-section direction
uniform sampler2D uPos;        // N x 1 RG32F: each row's place on the track (0..1) and size
uniform int uHead, uN, uM;
uniform float uFrac, uAmp, uWidth, uTwist;
uniform mat4 uProj, uView;
out float vAge, vDepth, vSample, vEmpty;

vec3 at(int r, int k0, int k1, float a) {
  return mix(texelFetch(uTrack, ivec2(k0, r), 0).xyz, texelFetch(uTrack, ivec2(k1, r), 0).xyz, a);
}

void main() {
  int i = int(aIdx.y);
  int j = int(aIdx.x) % uM;    // j = M re-samples texel 0, which the ring taper holds at ~0
  int row = (uHead - i + uN) % uN;
  float s = texelFetch(uHist, ivec2(j, row), 0).r;
  vEmpty = step(1e5, s);                                   // rows not yet written stay invisible
  s *= 1.0 - vEmpty;
  float age = (float(i) + uFrac) / float(uN - 1);         // 0 newest (head) .. 1 oldest (tail)

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
  vec3 ww = cos(uTwist) * w + sin(uTwist) * b;             // the beat's wring
  vec3 n = cross(t, ww);
  float v = (aIdx.x / float(uM) * 2.0 - 1.0) * uWidth;
  vec3 p = c + placed.g * (v * ww + uAmp * s * n);        // this slice's own size; waveform along the normal
  vec4 e = uView * vec4(p, 1.0);
  vAge = age;
  vDepth = -e.z;
  vSample = s;
  gl_Position = uProj * e;
}
