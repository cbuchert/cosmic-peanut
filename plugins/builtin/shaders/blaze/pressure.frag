#version 300 es
// One Jacobi iteration of the pressure Poisson equation (warm-started from the last step).
// The top edge is open (pressure 0) so gas can leave; the other edges are closed (Neumann).
precision highp float;
out vec4 o;
uniform sampler2D u_p;
uniform sampler2D u_div;
float pr(ivec2 q) {
  ivec2 s = textureSize(u_p, 0);
  if (q.y >= s.y) return 0.0;
  return texelFetch(u_p, clamp(q, ivec2(0), s - 1), 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sum = pr(p + ivec2(1, 0)) + pr(p - ivec2(1, 0)) + pr(p + ivec2(0, 1)) + pr(p - ivec2(0, 1));
  o = vec4(0.25 * (sum - texelFetch(u_div, p, 0).r), 0.0, 0.0, 1.0);
}
