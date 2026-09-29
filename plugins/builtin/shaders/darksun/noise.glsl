// Shared by backdrop.frag and darksun.frag (spliced in at "// #include noise").
// Smooth value noise (quintic), integer hash: no sin() precision artefacts.
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 32768);
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= h >> 13;
  return float(h) * (1.0 / 4294967295.0);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s / 0.9375;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1;
    a *= 0.5;
  }
  return s / 0.875;
}

// A watercolour wash: warped fbm, with pigment pooling at the wash's soft edges.
float wash(vec2 p, float t) {
  vec2 w = vec2(fbm3(p * 0.9 + vec2(t, 0.0)), fbm3(p * 0.9 + vec2(4.7, 1.3 - t)));
  float v = fbm(p + 1.8 * w);
  float edge = 1.0 - smoothstep(0.0, 0.07, abs(v - 0.52));
  return v - 0.12 * edge;
}

// A point on a circle of radius k (so noise sampled at it is seamless in angle; ~2k cells around).
vec2 circ(float a, float k) { return vec2(cos(a), sin(a)) * k; }
