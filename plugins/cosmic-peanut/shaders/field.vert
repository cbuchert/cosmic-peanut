#version 300 es
// Möbius Field: every band is the closed Möbius band (Möbius's loop track at Length 1), drawn for
// all bands at once with instancing. One vertex per (point j, slice i) of a static grid, as in
// mobius.vert; the per-instance attributes place, orient and vary each band (src/lib/field.js).
// The loop is analytic here, the same curve and frame as track.js's table: centre c = (cos u, 0,
// sin u) over two laps (u = 4π q), tangent t, cross-section w = cos(u/2)·c + sin(u/2)·up, so a
// slice comes back flipped after one lap. Slices sit one apart behind the head and glide between
// pushes (uFrac). Each band lags its own number of history rows (aBand.y), so neighbours show
// different moments of the shared history. Size is per slice: uPos.g holds the scale each row was
// laid at (beat breath × bass swell), so nothing already on a band grows on a beat. The beat's
// wring turns w about t by uTwist, to this band's side (aBand.w).
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: point across the strip (0..M/uStride), y: slice (0 = newest)
in vec4 aOff;                  // band centre minus the camera, and the band's fade
in vec4 aRot;                  // orientation × spin, a unit quaternion
in vec4 aBand;                 // scale, history lag (rows), palette shift, wring side (±1)
uniform sampler2D uHist;       // M x N waveform history, circular in rows
uniform sampler2D uPos;        // N x 1 RG32F: .g is the size each row was laid at
uniform int uHead, uN, uM, uStride, uSlices;
uniform float uFrac, uAmp, uWidth, uTwist;
uniform mat4 uProj, uView;
out float vAge, vSample, vEmpty, vFade, vHue;

vec3 rotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int i = int(aIdx.y);
  int j = int(aIdx.x) * uStride;
  int row = (uHead - i - int(aBand.y) + 2 * uN) % uN;
  float s = texelFetch(uHist, ivec2(j % uM, row), 0).r;  // j = M re-samples texel 0 (tapered ~0)
  vEmpty = step(1e5, s);                                   // rows not yet written stay invisible
  s *= 1.0 - vEmpty;
  float size = texelFetch(uPos, ivec2(row, 0), 0).g;

  float slot = float(i) + uFrac;
  float u = -12.56637061 * slot / float(uSlices);          // two laps of the loop per band
  vec3 c = vec3(cos(u), 0.0, sin(u));
  vec3 t = vec3(-sin(u), 0.0, cos(u));
  vec3 w = cos(0.5 * u) * c + vec3(0.0, sin(0.5 * u), 0.0);
  float phi = uTwist * aBand.w;
  vec3 ww = cos(phi) * w + sin(phi) * cross(t, w);         // the beat's wring
  vec3 n = cross(t, ww);
  float v = (float(j) / float(uM) * 2.0 - 1.0) * uWidth;
  vec3 local = c + size * (v * ww + uAmp * s * n);         // this slice's own size; waveform on the normal
  vec3 p = aOff.xyz + aBand.x * rotate(aRot, local);

  vAge = slot / float(uSlices - 1);                        // 0 head .. 1 tail
  vSample = s;
  vFade = aOff.w;
  vHue = aBand.z;
  gl_Position = uProj * (uView * vec4(p, 1.0));
}
