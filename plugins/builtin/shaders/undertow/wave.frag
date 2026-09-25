#version 300 es
precision highp float;
in float v_edge;
in float v_level;
out vec4 o;
uniform vec3 u_color;
uniform float u_gain;
void main() {
  // Soft falloff across the line width reads as glow once the feedback smears it.
  float a = 1.0 - v_edge * v_edge;
  o = vec4(u_color * a * v_level * u_gain, 1.0);
}
