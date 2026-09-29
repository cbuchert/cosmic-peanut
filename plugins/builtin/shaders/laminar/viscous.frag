#version 300 es
// One Jacobi iteration of the implicit viscous step (v − α∇²v = v₀, α = ν·dt / h²), so a low
// Reynolds number stays stable at any grid size. No-slip on the sphere, inflow at the left.
precision highp float;
out vec4 o;
uniform sampler2D u_x;   // current iterate
uniform sampler2D u_b;   // velocity before diffusion
uniform float u_alpha;
// #include common
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 s = velAt(u_x, p + ivec2(1, 0)) + velAt(u_x, p - ivec2(1, 0)) + velAt(u_x, p + ivec2(0, 1)) + velAt(u_x, p - ivec2(0, 1));
  vec2 v = (texelFetch(u_b, p, 0).xy + u_alpha * s) / (1.0 + 4.0 * u_alpha);
  if (solid(posOf(p))) v = solidVel(posOf(p));
  o = vec4(v, 0.0, 1.0);
}
