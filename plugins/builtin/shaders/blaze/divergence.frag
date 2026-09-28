#version 300 es
// Divergence of the velocity field, in texel units (grid spacing cancels in the solve).
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
vec2 vel(ivec2 p) {
  ivec2 s = textureSize(u_vel, 0);
  return texelFetch(u_vel, clamp(p, ivec2(0), s - 1), 0).xy;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = vel(p + ivec2(1, 0)).x - vel(p - ivec2(1, 0)).x + vel(p + ivec2(0, 1)).y - vel(p - ivec2(0, 1)).y;
  o = vec4(0.5 * d, 0.0, 0.0, 1.0);
}
