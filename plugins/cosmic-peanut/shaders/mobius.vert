#version 300 es
// Möbius: one vertex per (point j, ring i), like rings.vert, but each ring is an open slice across
// the strip's width (v = −W..W as j = 0..M) and travels along it. Age 0..1 maps to u = 0..4π, two
// laps: the half twist brings a slice back upside down after one lap and lined up after two, so
// birth and death meet seamlessly at u = 0 ≡ 4π (the age fades in rings.frag cover the overlap).
// The strip lies in the horizontal plane with the twist out of plane:
//   p(u, v) = ((R + v·cos(u/2))·cos u, v·sin(u/2), (R + v·cos(u/2))·sin u)
// and the waveform pushes along the surface normal, which flips over once per lap.
// On the beat (src/lib/beat.js) the strip wrings: a twist offset φ = uTwist joins the half twist,
// u/2 + φ, so it rolls about its centre line. φ is the same for every u, so the slices at u and
// u + 2π still differ by π and it stays a Möbius strip. uBreath swells the width with it.
precision highp float;
precision highp sampler2D;

in vec2 aIdx;                  // x: point across the strip (0..M), y: ring age index (0 = newest)
uniform sampler2D uHist;       // M x N waveform history, circular in rows
uniform int uHead, uN, uM;
uniform float uFrac, uAmp, uPulse, uWidth, uTwist, uBreath;
uniform mat4 uProj, uView;
out float vAge, vDepth, vSample, vEmpty;

const float R = 1.0;           // centerline radius (shapes.js MOBIUS_RADIUS)

void main() {
  int i = int(aIdx.y);
  int j = int(aIdx.x) % uM;    // j = M re-samples texel 0, which the ring taper holds at ~0
  int row = (uHead - i + uN) % uN;
  float s = texelFetch(uHist, ivec2(j, row), 0).r;
  vEmpty = step(1e5, s);                                   // rows not yet written stay invisible
  s *= 1.0 - vEmpty;
  float age = (float(i) + uFrac) / float(uN - 1);         // 0 newest .. 1 oldest
  float u = clamp(age, 0.0, 1.0) * 12.5663706;             // two laps
  float v = (aIdx.x / float(uM) * 2.0 - 1.0) * uWidth * uBreath;
  float tw = 0.5 * u + uTwist;                             // half twist plus the beat's wring
  float cu = cos(u), su = sin(u), ch = cos(tw), sh = sin(tw);
  float rho = R + v * ch;
  vec3 p = vec3(rho * cu, v * sh, rho * su);
  vec3 du = vec3(-rho * su - 0.5 * v * sh * cu, 0.5 * v * ch, rho * cu - 0.5 * v * sh * su);
  vec3 dv = vec3(ch * cu, sh, ch * su);
  vec3 n = normalize(cross(du, dv));
  p = (p + uAmp * s * n) * (1.0 + uPulse * 0.06);        // waveform along the normal; bass swells it all
  vec4 e = uView * vec4(p, 1.0);
  vAge = age;
  vDepth = -e.z;
  vSample = s;
  gl_Position = uProj * e;
}
