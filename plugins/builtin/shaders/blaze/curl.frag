#version 300 es
// Vorticity (z of curl) of the velocity field, in 1/s, for vorticity confinement.
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
uniform vec2 u_venc;   // stored = v * x + y (identity for float targets)
uniform float u_inv;   // 1 / texel size in height units (= sim height)
vec2 vel(ivec2 p) {
  ivec2 s = textureSize(u_vel, 0);
  return (texelFetch(u_vel, clamp(p, ivec2(0), s - 1), 0).xy - u_venc.y) / u_venc.x;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float w = (vel(p + ivec2(1, 0)).y - vel(p - ivec2(1, 0)).y) - (vel(p + ivec2(0, 1)).x - vel(p - ivec2(0, 1)).x);
  o = vec4(0.5 * w * u_inv, 0.0, 0.0, 1.0);
}
