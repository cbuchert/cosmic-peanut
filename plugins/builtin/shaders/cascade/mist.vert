#version 300 es
// Spray (and water about to hit the pool) as big soft points into the low-res mist buffer.
precision highp float;
precision highp int;
uniform highp sampler2D u_s0;
uniform highp sampler2D u_s1;
uniform int u_count;
uniform float u_aspect;
uniform float u_poolY;
uniform float u_size;       // point size in mist-buffer pixels
out float v_a;
void main() {
  int id = gl_VertexID;
  int w = textureSize(u_s0, 0).x;
  ivec2 ij = ivec2(id % w, id / w);
  vec4 s0 = texelFetch(u_s0, ij, 0);
  vec4 s1 = texelFetch(u_s1, ij, 0);
  float kind = s1.y;
  float nearPool = kind > 0.5 && kind < 1.5 ? clamp(1.0 - (s0.y - u_poolY) * 12.0, 0.0, 1.0) : 0.0;
  float a = kind > 1.5 ? s1.z * (1.0 - clamp(s1.x / max(s1.w, 1e-3), 0.0, 1.0)) : nearPool * s1.z * 0.4;
  if (a <= 0.0 || id >= u_count) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_Position = vec4(s0.x * 2.0 / u_aspect, s0.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_size;
  v_a = a;
}
