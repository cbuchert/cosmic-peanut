#version 300 es
precision highp float;
in float v_a;
uniform float u_gain;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0) discard;
  float k = (1.0 - r) * (1.0 - r) * v_a * u_gain;
  o = vec4(k, k, k, 1.0);
}
