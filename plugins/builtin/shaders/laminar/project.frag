#version 300 es
// Subtract the pressure gradient (what's left is nearly divergence-free), then re-impose the
// boundaries: inflow column, and fluid inside the sphere moving with it.
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
uniform sampler2D u_p;
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
  vec2 v = texelFetch(u_vel, p, 0).xy;
  v -= 0.5 * vec2(pr(p + ivec2(1, 0), pc) - pr(p - ivec2(1, 0), pc), pr(p + ivec2(0, 1), pc) - pr(p - ivec2(0, 1), pc));
  if (p.x == 0) v = vec2(u_U, 0.0);
  vec2 P = posOf(p);
  if (solid(P)) v = solidVel(P);
  o = vec4(v, 0.0, 1.0);
}
