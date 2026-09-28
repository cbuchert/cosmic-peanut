#version 300 es
// Mist feedback: last frame's (blurred) mist drifts up and sideways in a slow billow and decays.
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform float u_time;
uniform float u_rise;     // uv per frame
uniform float u_decay;
out vec4 o;
void main() {
  vec2 uv = v_uv;
  float bx = sin(uv.y * 14.0 + u_time * 0.7) * 0.6 + sin(uv.y * 5.0 - u_time * 0.4 + uv.x * 6.0) * 0.4;
  float spread = (uv.x - 0.5) * 0.4;
  vec2 off = vec2((bx * 0.35 + spread) * u_rise, u_rise);
  o = vec4(texture(u_prev, uv - off).rgb * u_decay, 1.0);
}
