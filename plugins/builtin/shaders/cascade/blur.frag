#version 300 es
// 9-tap Gaussian along u_dir (two linear-filtered taps per side pair), separable.
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;   // texel step, e.g. (1/w, 0)
out vec4 o;
void main() {
  vec3 c = texture(u_src, v_uv).rgb * 0.227027;
  c += texture(u_src, v_uv + u_dir * 1.384615).rgb * 0.316216;
  c += texture(u_src, v_uv - u_dir * 1.384615).rgb * 0.316216;
  c += texture(u_src, v_uv + u_dir * 3.230769).rgb * 0.070270;
  c += texture(u_src, v_uv - u_dir * 3.230769).rgb * 0.070270;
  o = vec4(c, 1.0);
}
