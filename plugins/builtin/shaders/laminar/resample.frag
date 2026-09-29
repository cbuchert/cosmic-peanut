#version 300 es
// Carry the state over a resize: the new grid samples the old one at the same place in the flow
// (both centred on the screen centre, in screen heights). ψ is relative to each texel's y, so it
// picks up the shift between the grids' origins.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_old;
uniform vec2 u_Lnew;
uniform vec2 u_Lold;
uniform float u_psi;   // 1 for the scalar field, 0 for velocity
void main() {
  vec2 P = v_uv * u_Lnew + 0.5 * (u_Lold - u_Lnew);
  vec4 s = texture(u_old, P / u_Lold);
  s.r += u_psi * 0.5 * (u_Lold.y - u_Lnew.y);
  o = s;
}
