// Shared noise for Eclipse (spliced into the shaders at "// #include noise").

// Sin-free hash → gradient in [-1, 1]^2 (Dave Hoskins).
vec2 hash2(vec2 p) {
  vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

// Gradient noise (≈ −0.7..0.7), periodic in x with integer period `per`.
float gnoise(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float i0 = mod(i.x, per);
  float i1 = mod(i.x + 1.0, per);
  float a = dot(hash2(vec2(i0, i.y)), f);
  float b = dot(hash2(vec2(i1, i.y)), f - vec2(1.0, 0.0));
  float c = dot(hash2(vec2(i0, i.y + 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash2(vec2(i1, i.y + 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

const float BIG = 4096.0; // "not periodic" for the Cartesian cloud noise
const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p, BIG);
    p = ROT * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
