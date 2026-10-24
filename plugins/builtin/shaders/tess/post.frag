#version 300 es
// Tessellations, cinematic Look: the composite (paper.frag's job in classic). Upsample the print
// (after the depth of field, where the surface has it), add the faint highlight bloom, press it
// into paper at full resolution — the classic's fibres, tooth and mottle, and the fibres now
// catch the raking light (a small emboss of their relief towards the light's screen direction)
// — then the film-like tone curve (lib/tess-look.js tone) and the display encode. The paper
// covers every pixel: the canvas stays opaque (lib/tess-look.js compositeAlpha).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_print;
uniform sampler2D u_bloom;
uniform float u_bloomN;    // levels summed into u_bloom (0: no bloom)
uniform float u_bloomK;    // its share (lib/tess-look.js BLOOM_GAIN)
uniform vec3 u_paper;      // linear
uniform float u_grain;     // paper texture strength
uniform vec2 u_lightScr;   // the key light's direction on screen (unit, or 0: no emboss)

#define TONE_KNEE 0.93     // lib/tess-look.js
#define FIBRE_LIT 0.06

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

float fibre(vec2 frag) { return vnoise(vec2(frag.x * 0.05 + frag.y * 0.012, frag.y * 0.6)) - 0.5; }

vec3 tone(vec3 x) {
  vec3 w = vec3(1.0 - TONE_KNEE);
  vec3 sh = TONE_KNEE + w * (1.0 - exp(-(x - TONE_KNEE) / w));
  return mix(max(x, 0.0), sh, step(TONE_KNEE, x));
}

void main() {
  vec3 c = texture(u_print, v_uv).rgb;
  if (u_bloomN > 0.0) c += u_bloomK * texture(u_bloom, v_uv).rgb / u_bloomN;
  vec2 frag = gl_FragCoord.xy;
  float fib = fibre(frag);
  // The fibres' relief: their slope towards the light lifts them, away darkens (a raking light;
  // one difference along the light's screen direction).
  float lit = fibre(frag + u_lightScr) - fib;
  float tooth = hash12(floor(frag)) - 0.5;
  float mottle = vnoise(frag * 0.008) - 0.5;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float skip = max(0.0, tooth) * (1.0 - smoothstep(0.0, 0.3, lum)) * 0.35 * u_grain;
  c = mix(c, u_paper, skip * 0.25);
  c *= 1.0 + u_grain * (0.05 * fib + 0.035 * tooth + 0.05 * mottle + FIBRE_LIT * lit);
  o = vec4(pow(tone(c), vec3(1.0 / 2.2)), 1.0);
}
