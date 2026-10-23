#version 300 es
// Tessellation composite: upsample the print pass and press it into paper at full resolution
// (fibres, tooth, mottle; ink skips the high tooth a little). Linear in, opaque sRGB out.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_print;
uniform vec3 u_paper;      // linear
uniform float u_grain;     // paper texture strength

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

void main() {
  vec3 c = texture(u_print, v_uv).rgb;
  vec2 frag = gl_FragCoord.xy;
  float fib = vnoise(vec2(frag.x * 0.05 + frag.y * 0.012, frag.y * 0.6)) - 0.5;
  float tooth = hash12(floor(frag)) - 0.5;
  float mottle = vnoise(frag * 0.008) - 0.5;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float skip = max(0.0, tooth) * (1.0 - smoothstep(0.0, 0.3, lum)) * 0.35 * u_grain;
  c = mix(c, u_paper, skip * 0.25);
  c *= 1.0 + u_grain * (0.05 * fib + 0.035 * tooth + 0.05 * mottle);
  o = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
}
