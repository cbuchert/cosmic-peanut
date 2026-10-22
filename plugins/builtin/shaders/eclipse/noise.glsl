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

// 3D gradient noise (≈ −0.8..0.8), for fields that evolve: z is time, so shapes are born, grow
// and dissolve rather than slide.
vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}

float gnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(hash3(i), f);
  float n100 = dot(hash3(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(hash3(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(hash3(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(hash3(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(hash3(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(hash3(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(hash3(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
             mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
}

// Four octaves of 3D noise in xy (rotated like fbm), with z advancing by octave so finer detail
// churns faster. Returns (all four octaves, the first two: the same shapes without fine detail).
vec2 fbm3(vec2 p, float z) {
  float s = 0.0;
  float a = 0.5;
  float coarse = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise3(vec3(p, z));
    if (i == 1) coarse = s;
    p = ROT * p * 2.03 + 17.1;
    z = z * 1.6 + 3.7;
    a *= 0.5;
  }
  return vec2(s, coarse);
}
