#version 300 es
// Additive glow: cosine palette by age, far side dimmer (implies the sphere), newest brightest.
precision highp float;

in float vAge, vDepth, vSample, vEmpty;
uniform float uCamDist, uRadius, uGain, uPalette, uPulse;
out vec4 o;

vec3 pal(float t) {
  if (uPalette < 0.5) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.55, 0.70, 0.85)));       // nebula
  if (uPalette < 1.5) return 0.5 + 0.5 * cos(6.28318 * (t * 0.7 + vec3(0.0, 0.12, 0.25)));  // ember
  return vec3(0.25, 1.0, 0.55) * (0.6 + 0.4 * cos(6.28318 * t));                             // phosphor
}

void main() {
  float edges = smoothstep(0.0, 0.035, vAge) * (1.0 - smoothstep(0.88, 1.0, vAge));
  float back = clamp((vDepth - (uCamDist - uRadius)) / (2.0 * uRadius), 0.0, 1.0);
  float depthFade = mix(1.0, 0.16, back);
  float fresh = mix(1.5, 0.35, vAge);
  vec3 c = pal(vAge * 0.55 - uPulse * 0.08) + abs(vSample) * 0.35 + uPulse * 0.12;
  o = vec4(c * edges * depthFade * fresh * uGain * (1.0 - vEmpty), 1.0);
}
