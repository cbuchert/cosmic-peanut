#version 300 es
// Möbius Field: rings.frag's glow per band. The same cosine palettes by age (shifted a little per
// band), newest brightest, beat glow on the newest slices; instead of the sphere's depth cue, each
// band's fade (fog far away, near fade up close; src/lib/field.js) dims it as a whole.
// Premultiplied for the transparent canvas, as in rings.frag: alpha = brightest channel, so with
// blend ONE, ONE the summed alpha always covers the summed colour.
precision highp float;

in float vAge, vSample, vEmpty, vFade, vHue;
uniform float uGain, uPalette, uPulse, uGlow;
out vec4 o;

vec3 pal(float t) {
  if (uPalette < 0.5) return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.55, 0.70, 0.85)));       // nebula
  if (uPalette < 1.5) return 0.5 + 0.5 * cos(6.28318 * (t * 0.7 + vec3(0.0, 0.12, 0.25)));  // ember
  return vec3(0.25, 1.0, 0.55) * (0.6 + 0.4 * cos(6.28318 * t));                             // phosphor
}

void main() {
  float edges = smoothstep(0.0, 0.035, vAge) * (1.0 - smoothstep(0.88, 1.0, vAge));
  float fresh = mix(1.5, 0.35, vAge) * (1.0 + uGlow * (1.0 - smoothstep(0.0, 0.18, vAge)));
  vec3 c = pal(vAge * 0.55 - uPulse * 0.08 + vHue) + abs(vSample) * 0.35 + uPulse * 0.12;
  c *= edges * fresh * vFade * uGain * (1.0 - vEmpty);
  o = vec4(c, max(c.r, max(c.g, c.b)));
}
