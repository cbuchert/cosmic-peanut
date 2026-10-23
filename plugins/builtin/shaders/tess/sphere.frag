#version 300 es
// Tiled Sphere: the p4 tiling on a cube-sphere, seen from outside or from inside. Each pixel's
// ray hits the unit sphere; the hit's face (largest component) gives the equal-angle face plane
// [0, N]² (src/lib/cube-sphere.js, mirrored and tested there). Across an edge two faces' planes
// differ by a quarter turn and whole-face translation, a symmetry of the p4 warp, so the tiles
// carry on. S is the face chart's analytic Jacobian times the screen derivatives of the hit
// point, which are smooth across faces, so outlines keep their weight over the edges. Tiles are
// recoloured by the face that owns them (TESS_CLASS) and ringed by angle from a pole (TESS_RING).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform mat3 u_frame[6];   // per face: columns n, u, v
uniform ivec4 u_nb[24];    // per (face, side): face across, quarter turns, seam, low side
uniform vec2 u_nbT[24];    // that crossing's translation: p' = turn(p, k) + t
uniform int u_flip[6];     // per-face class flip
uniform float u_N;         // lattice cells per face
uniform vec3 u_pole;       // ring pole, sphere frame

int g_face;                // the face of this pixel's hit

vec2 sphTurn(vec2 p, int k) {
  k = k & 3;
  return k == 0 ? p : k == 1 ? vec2(-p.y, p.x) : k == 2 ? -p : vec2(p.y, -p.x);
}

// The face whose square holds plane point c of g_face (c is a warped tile centre, so it may lie
// just past an edge): returns it, with c in its plane and the class parity the crossing turns.
int sphOwner(vec2 c, out vec2 co, out int par) {
  co = c;
  par = 0;
  int s = -1;
  float e = 0.0;
  if (c.x - u_N > e) { s = 0; e = c.x - u_N; }
  if (-c.x > e) { s = 1; e = -c.x; }
  if (c.y - u_N > e) { s = 2; e = c.y - u_N; }
  if (-c.y > e) { s = 3; e = -c.y; }
  if (s < 0) return g_face;
  int k = g_face * 4 + s;
  ivec4 nb = u_nb[k];
  co = sphTurn(c, nb.y) + u_nbT[k];
  par = nb.y & 1;
  return nb.x;
}

// A tile's colour class (cube-sphere.js tileColor): its owner's checkerboard class, flipped per
// face; along the four seam edges every other tile takes the third class.
int sphClass(int cls, vec2 c) {
  vec2 co;
  int par;
  int g = sphOwner(c, co, par);
  int col = (cls ^ par) ^ u_flip[g];
  ivec2 ij = ivec2(floor(2.0 * co));
  int last = int(2.0 * u_N + 0.5) - 1;
  for (int side = 0; side < 4; side++) {
    ivec4 nb = u_nb[g * 4 + side];
    if (nb.z == 0) continue;
    bool touches = side == 0 ? ij.x == last : side == 1 ? ij.x == 0 : side == 2 ? ij.y == last : ij.y == 0;
    if (touches && col == (nb.w == 1 ? 0 : 1)) return 2;
  }
  return col;
}

vec3 sphDir(int f, vec2 p) {
  vec2 t = tan(0.785398163 * (2.0 * p / u_N - 1.0));
  mat3 F = u_frame[f];
  return normalize(F[0] + t.x * F[1] + t.y * F[2]);
}

// Ring by angle from the pole: figure/ground fronts sweep the sphere like a terminator.
float sphRing(vec2 c) {
  vec2 co;
  int par;
  int g = sphOwner(c, co, par);
  return acos(clamp(dot(sphDir(g, co), u_pole), -1.0, 1.0)) / 3.14159265;
}

#define TESS_CLASS(cls, c) sphClass(cls, c)
#define TESS_RING(c) sphRing(c)
// #include tess

uniform vec2 u_res;        // target size (px)
uniform vec3 u_eye;        // camera position (world; sphere radius 1 at the origin)
uniform mat3 u_cam;        // camera basis: right, up, forward
uniform float u_tanHalf;   // tan(vertical fov / 2)
uniform mat3 u_rot;        // world → sphere frame
uniform float u_inside;    // 1: the camera is inside, take the far hit
uniform float u_veil;      // 0–1: the print fades to paper while the camera crosses the surface
uniform float u_discR;     // the sphere's screen radius (outside), in half-heights
uniform vec3 u_light;      // world, unit

void main() {
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * u_res.y);
  vec3 rd = normalize(u_cam * vec3(s * u_tanHalf, 1.0));
  float b = dot(u_eye, rd);
  vec3 close = u_eye - b * rd;                       // the ray's closest point to the centre
  float disc = 1.0 - dot(close, close);
  float sq = sqrt(max(disc, 0.0));
  bool inside = u_inside > 0.5;
  // The hit; a miss takes the closest point's direction, which keeps h continuous over the limb.
  vec3 hw = disc > 0.0 ? u_eye + (inside ? -b + sq : -b - sq) * rd : normalize(close);
  vec3 h = normalize(u_rot * hw);
  vec3 dhx = dFdx(h);
  vec3 dhy = dFdy(h);
  float edge = length(close) - 1.0;                  // outside: < 0 on the disc
  float cover = inside ? 1.0 : clamp(0.5 - edge / max(fwidth(edge), 1e-6), 0.0, 1.0);

  vec3 ah = abs(h);
  g_face = ah.x >= ah.y && ah.x >= ah.z ? (h.x >= 0.0 ? 0 : 1) : ah.y >= ah.z ? (h.y >= 0.0 ? 2 : 3) : (h.z >= 0.0 ? 4 : 5);
  mat3 F = u_frame[g_face];
  float w = dot(h, F[0]);
  float su = dot(h, F[1]);
  float sv = dot(h, F[2]);
  vec2 p = 0.5 * u_N * (1.0 + atan(vec2(su, sv) / w) / 0.785398163);
  // dp/dh of the face chart (cube-sphere.js faceJacobian), times the screen derivatives.
  float kk = 2.0 * u_N / 3.14159265;
  vec3 ju = kk / (w * w + su * su) * (w * F[1] - su * F[0]);
  vec3 jv = kk / (w * w + sv * sv) * (w * F[2] - sv * F[0]);
  mat2 S = mat2(dot(ju, dhx), dot(jv, dhx), dot(ju, dhy), dot(jv, dhy));

  vec3 paper = u_tPaper;
  vec3 bg = paper;
  if (!inside) {
    // A soft shadow under the floating sphere, down and to the right.
    float r = length(s - vec2(0.05, -0.08) * u_discR) / max(u_discR, 1e-3);
    bg *= 1.0 - 0.12 * (1.0 - smoothstep(0.75, 1.35, r));
  }
  vec3 col = bg;
  if (cover > 0.0) {
    col = tessShade(p, S).rgb;
    vec3 n = normalize(hw);
    float ndv = abs(dot(n, rd));
    float lit = inside ? 0.82 + 0.18 * ndv : 0.9 + 0.12 * dot(n, u_light);
    float limb = inside ? 1.0 : 1.0 - 0.38 * pow(1.0 - ndv, 2.0);
    col *= lit * limb;
  }
  col = mix(bg, col, cover);
  o = vec4(mix(col, paper, u_veil), 1.0);
}
