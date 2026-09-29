#version 300 es
// One Jacobi iteration of the pressure Poisson equation (warm-started from the last step). Open
// outflow on the right (p = 0); the inflow, the side walls and the sphere are closed (Neumann).
precision highp float;
out vec4 o;
uniform sampler2D u_p;
uniform sampler2D u_div;
// #include common
float pr(ivec2 q, float pc) {
  ivec2 s = textureSize(u_p, 0);
  if (q.x >= s.x) return 0.0;
  if (q.x < 0 || q.y < 0 || q.y >= s.y) return pc;
  if (solid(posOf(q))) return pc;
  return texelFetch(u_p, q, 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float pc = texelFetch(u_p, p, 0).r;
  float sum = pr(p + ivec2(1, 0), pc) + pr(p - ivec2(1, 0), pc) + pr(p + ivec2(0, 1), pc) + pr(p - ivec2(0, 1), pc);
  o = vec4(0.25 * (sum - texelFetch(u_div, p, 0).r), 0.0, 0.0, 1.0);
}
