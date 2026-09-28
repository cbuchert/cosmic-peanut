#version 300 es
// Streak profile: soft across, brighter toward the head. Additive into a float target.
precision highp float;
in vec2 v_q;
in float v_bright;
in float v_t;
uniform vec3 u_stops[4];
uniform float u_gain;
out vec4 o;
vec3 ramp(float t) {
  float p = clamp(t, 0.0, 1.0) * 3.0;
  int k = min(2, int(p));
  return mix(u_stops[k], u_stops[k + 1], p - float(k));
}
void main() {
  float across = exp(-v_q.x * v_q.x * 2.2);
  float along = mix(0.2, 1.0, v_q.y * v_q.y);
  o = vec4(ramp(v_t) * (v_bright * across * along * u_gain), 1.0);
}
