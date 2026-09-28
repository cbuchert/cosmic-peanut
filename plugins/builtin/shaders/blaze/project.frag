#version 300 es
// Subtract the pressure gradient: what's left of the velocity is (nearly) divergence-free, so
// rising heat rolls into swirls instead of piling up into hard fronts.
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
uniform sampler2D u_p;
float pr(ivec2 q) {
  ivec2 s = textureSize(u_p, 0);
  if (q.y >= s.y) return 0.0;
  return texelFetch(u_p, clamp(q, ivec2(0), s - 1), 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 v = texelFetch(u_vel, p, 0).xy;
  v -= 0.5 * vec2(pr(p + ivec2(1, 0)) - pr(p - ivec2(1, 0)), pr(p + ivec2(0, 1)) - pr(p - ivec2(0, 1)));
  o = vec4(v, 0.0, 1.0);
}
