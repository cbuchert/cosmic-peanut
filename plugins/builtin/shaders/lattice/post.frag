#version 300 es
// Lattice composite: upsample the raymarch pass (linear, premultiplied) onto the canvas as
// premultiplied sRGB, with a little dither so the fog's gradients don't band.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_scene;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

#ifdef CINEMATIC
// The cinematic look: the scene pass is HDR linear radiance (premultiplied by coverage). Add the
// bloom chain's result (lib/lattice-bloom.js; Jimenez 2014: a small, energy-conserving mix rather
// than a threshold), tone-map with Narkowicz's ACES filmic fit (lib/lattice-look.js tone), encode
// as classic does, and keep the canvas premultiplied: alpha = max(coverage, brightest channel),
// so light on black stays light over the desktop (lib/lattice-look.js compositeAlpha).
uniform sampler2D u_bloom;
uniform float u_bloomN;  // levels summed into u_bloom
uniform float u_bloomK;  // bloom mix

const float TONE_EXPOSURE = 0.8; // lib/lattice-look.js EXPOSURE
vec3 tone(vec3 x) {
  vec3 v = max(x, 0.0) * TONE_EXPOSURE;
  return min(vec3(1.0), (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
}

void main() {
  vec4 c = texture(u_scene, v_uv);
  vec3 b = texture(u_bloom, v_uv).rgb / u_bloomN;
  vec3 hdr = mix(max(c.rgb, 0.0), max(b, 0.0), u_bloomK);
  vec3 srgb = pow(tone(hdr), vec3(1.0 / 2.2));
  srgb = max(srgb + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 0.0);
  float a = min(1.0, max(c.a, max(srgb.r, max(srgb.g, srgb.b))));
  o = vec4(min(srgb, vec3(a)), a);
}
#else
void main() {
  vec4 c = texture(u_scene, v_uv);
  if (c.a <= 1e-4) {
    o = vec4(0.0);
    return;
  }
  vec3 srgb = pow(clamp(c.rgb / c.a, 0.0, 1.0), vec3(1.0 / 2.2));
  srgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(srgb * c.a, c.a);
}
#endif
