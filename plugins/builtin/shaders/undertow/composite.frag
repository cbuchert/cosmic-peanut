#version 300 es
// Feedback buffer -> screen: exposure, gentle tone map, vignette.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_exposure;
void main() {
  vec3 c = texture(u_src, v_uv).rgb * u_exposure;
  c = 1.0 - exp(-c);                       // soft shoulder, never clips hard
  vec2 d = v_uv - 0.5;
  c *= 1.0 - 0.55 * dot(d, d) * 2.0;       // vignette
  o = vec4(pow(c, vec3(0.9)), 1.0);
}
