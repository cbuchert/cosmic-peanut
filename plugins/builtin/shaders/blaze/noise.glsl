// Shared noise for Blaze, spliced in where a shader says `// #include noise`.
// Hash-based 3D gradient noise (no textures, no precision-hungry sin hashes).
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx) * 2.0 - 1.0;
}
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash33(i), f);
  float b = dot(hash33(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float c = dot(hash33(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float d = dot(hash33(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(hash33(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float g = dot(hash33(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float h = dot(hash33(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float k = dot(hash33(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
