#version 300 es
// Cinematic look: rings.frag's colour for the sphere and Möbius, as linear light into the float
// scene. The classic colour is decoded from display (gamma 2.2) so a lone line keeps about its
// classic brightness through the composite's tone curve, then weighted by the prefiltered coverage
// at this distance from the line (Chan & Durand 2005; src/lib/quads.js `coverage`).
precision highp float;

in float vAge, vDepth, vSample, vEmpty;
in float vDist, vHalf, vSigma;
uniform float uCamDist, uRadius, uGain, uPalette, uPulse, uGlow, uScale;
out vec4 o;

vec3 pal(float t) {
  if (uPalette < 0.5) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.55, 0.70, 0.85)));       // nebula
  if (uPalette < 1.5) return 0.5 + 0.5 * cos(6.28318 * (t * 0.7 + vec3(0.0, 0.12, 0.25)));  // ember
  return vec3(0.25, 1.0, 0.55) * (0.6 + 0.4 * cos(6.28318 * t));                             // phosphor
}

// Abramowitz & Stegun 7.1.26 (src/lib/quads.js erf).
float erf7(float x) {
  float a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign(x) * (1.0 - y * exp(-a * a));
}

// Display gamma 2.2 decode (src/lib/look.js GAMMA). The classic colour clips at 1 per line, as the
// classic RGBA8 target clips the whole sum.
vec3 toLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

float coverage(float d, float h, float s) {
  float k = 0.70710678 / s;
  return 0.5 * (erf7((h + d) * k) + erf7((h - d) * k));
}

void main() {
  float edges = smoothstep(0.0, 0.035, vAge) * (1.0 - smoothstep(0.88, 1.0, vAge));
  float back = clamp((vDepth - (uCamDist - uRadius)) / (2.0 * uRadius), 0.0, 1.0);
  float depthFade = mix(1.0, 0.16, back);
  float fresh = mix(1.5, 0.35, vAge) * (1.0 + uGlow * (1.0 - smoothstep(0.0, 0.18, vAge)));
  vec3 c = pal(vAge * 0.55 - uPulse * 0.08) + abs(vSample) * 0.35 + uPulse * 0.12;
  c *= edges * depthFade * fresh * uGain * (1.0 - vEmpty);
  c = toLinear(clamp(c, 0.0, 1.0)) * uScale * coverage(vDist, vHalf, vSigma);
  o = vec4(c, 0.0);
}
