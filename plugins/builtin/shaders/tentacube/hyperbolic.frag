// Tentacube background: a {p,q} tiling of the Poincaré disk, drifting through hyperbolic space.
//
// Per pixel: a disk point w (screen mode: the screen scaled so its corners sit just past the rim;
// env mode: an equirect direction, each hemisphere stereographically onto its own disk), then the
// view isometry z = T(w) (a Möbius or anti-Möbius map, rebased on the CPU so its coefficients stay
// small), then the triangle-group fold into the fundamental domain. src/lib/hyperbolic.js mirrors
// the maths (tiling(), fold(), mobiusApply()) and is tested. Tile edges (the geodesic circle C)
// glow; the triangle mirrors are faint; tiles are tinted by their generation (inversion count).
// Output is linear light; alpha is left 0 — the output pass sets alpha = max(r, g, b).
varying vec2 vUv;

uniform vec4 uM0;      // a.re, a.im, b.re, b.im
uniform vec4 uM1;      // c.re, c.im, d.re, d.im
uniform float uConj;   // 1: conjugate w first (orientation-reversing view)
uniform vec3 uTile;    // alpha = π/p, cx, r of circle C
uniform float uMode;   // 0: screen, 1: equirect environment
uniform vec2 uAspect;  // screen: (width/height, 1) × scale
uniform float uTime;
uniform float uHue;    // 0..1 palette rotation
uniform float uGlow;   // edge brightness (param × flash-limited pulse)
uniform float uFill;   // tile body brightness

const int FOLD_ITERATIONS = 60;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec2 w;
  float rimFade;
  if (uMode < 0.5) {
    w = (vUv * 2.0 - 1.0) * uAspect;
  } else {
    float lon = (vUv.x - 0.5) * 6.2831853;
    float lat = (vUv.y - 0.5) * 3.1415927;
    vec3 d = vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
    w = d.z <= 0.0 ? d.xy / (1.0 - d.z) : vec2(-d.x, d.y) / (1.0 + d.z);
    w *= 0.985;
  }
  float r2 = dot(w, w);
  if (r2 >= 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  // Size of this pixel in hyperbolic units (the metric is 2|dw| / (1 − |w|²)).
  float px = max(fwidth(w.x), fwidth(w.y)) * 2.0 / (1.0 - r2);

  // z = T(w)
  vec2 wc = uConj > 0.5 ? vec2(w.x, -w.y) : w;
  vec2 z = cdiv(cmul(uM0.xy, wc) + uM0.zw, cmul(uM1.xy, wc) + uM1.zw);

  // Fold into the fundamental triangle (mirrors fold() in hyperbolic.js).
  float a = uTile.x, cx = uTile.y, cr = uTile.z;
  float a2 = 2.0 * a;
  float gen = 0.0;
  for (int i = 0; i < FOLD_ITERATIONS; i++) {
    float ang = atan(z.y, z.x);
    float k = floor(ang / a2);
    float c = cos(-k * a2), s = sin(-k * a2);
    z = vec2(z.x * c - z.y * s, z.x * s + z.y * c);
    if (atan(z.y, z.x) > a) {
      c = cos(a2); s = sin(a2);
      z = vec2(z.x * c + z.y * s, z.x * s - z.y * c);
    }
    vec2 dz = z - vec2(cx, 0.0);
    float d2 = dot(dz, dz);
    if (d2 >= cr * cr) break;
    z = vec2(cx, 0.0) + dz * (cr * cr / d2);
    gen += 1.0;
  }

  // Distances in hyperbolic units (near the folded point; conformal factor at z).
  float lam = 2.0 / (1.0 - dot(z, z));
  float dEdge = (length(z - vec2(cx, 0.0)) - cr) * lam;              // to the tile edge
  float dMirror = min(abs(z.y), abs(dot(z, vec2(-sin(a), cos(a))))) * lam; // triangle mirrors
  float dCentre = length(z) * lam;                                    // towards the tile centre

  // Anti-aliased lines: a line of hyperbolic width `lw` under a pixel of size px keeps its energy.
  float lw = uMode < 0.5 ? 0.03 : 0.1; // wider in the (low-res) environment
  float cover = lw / max(lw, px);
  float edge = exp(-dEdge / max(lw, px)) * cover;
  float halo = exp(-dEdge / 0.18) * 0.18;
  float mirror = exp(-dMirror / max(0.01, px)) * (0.01 / max(0.01, px)) * 0.035;

  vec3 tint = hue(uHue + gen * 0.09 + 0.08 * sin(uTime * 0.05));
  vec3 tint2 = hue(uHue + 0.5 + gen * 0.043);
  vec3 col = tint * (edge + halo) * uGlow;
  col += tint2 * mirror * uGlow * (1.0 - uMode);
  col += mix(tint, tint2, 0.5) * uFill * (0.35 + 0.65 * exp(-dCentre * 0.8));
  // Crowded rim: fade into haze as the tiles get smaller than pixels.
  col *= uMode < 0.5 ? smoothstep(1.0, 0.94, sqrt(r2)) : smoothstep(1.0, 0.75, sqrt(r2));
  gl_FragColor = vec4(col, 0.0);
}
