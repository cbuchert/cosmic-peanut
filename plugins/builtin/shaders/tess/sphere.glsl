// The cube-sphere's chart, tile owners, colours and rings (src/lib/cube-sphere.js mirrors them),
// for the surfaces that show the sphere's tiling: sphere.frag (Tiled Sphere) and disk3d.frag (the
// tiled wall round the Poincaré Disk's coin). Spliced in with `// #include sphere`, before the
// engine (its hooks use these). The surface sets g_face to the face of the point it shades.
// sphCell and sphFlipDir are the relief's hooks (TESS_CELL, TESS_FLIP_DIR) for a surface that
// carves the sphere (Tiled Sphere with relief).

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


// ---- Relief (Tiled Sphere's TESS_RELIEF hooks; cube-sphere.js mirrors and tests them) --------

// sphOwner, also giving the crossing's quarter turns k: a chart vector v of g_face is
// sphTurn(v, k) in the owner's chart.
int sphOwnerK(vec2 c, out vec2 co, out int k) {
  co = c;
  k = 0;
  int s = -1;
  float e = 0.0;
  if (c.x - u_N > e) { s = 0; e = c.x - u_N; }
  if (-c.x > e) { s = 1; e = -c.x; }
  if (c.y - u_N > e) { s = 2; e = c.y - u_N; }
  if (-c.y > e) { s = 3; e = -c.y; }
  if (s < 0) return g_face;
  int i = g_face * 4 + s;
  ivec4 nb = u_nb[i];
  co = sphTurn(c, nb.y) + u_nbT[i];
  k = nb.y;
  return nb.x;
}

// The id a tile's lift variation and pops hash (cube-sphere.js tileKey, the engine's TESS_CELL):
// its owner's half-unit cell, faces 64 apart, so both halves of a tile split by an edge lift as one.
vec2 sphCell(vec2 c) {
  vec2 co;
  int k;
  int g = sphOwnerK(c, co, k);
  return floor(2.0 * co) + vec2(64.0 * float(g), 0.0);
}

// Across a turning card's axis (cube-sphere.js flipDir, the engine's TESS_FLIP_DIR): along the
// sphere away from the pole, the way the front travels, taken in the owner's chart and turned
// back into g_face's.
vec2 sphFlipDir(vec2 c) {
  vec2 co;
  int k;
  int g = sphOwnerK(c, co, k);
  vec3 d = sphDir(g, co);
  vec3 a = d * dot(d, u_pole) - u_pole;
  mat3 F = u_frame[g];
  float w = dot(d, F[0]);
  float su = dot(d, F[1]);
  float sv = dot(d, F[2]);
  float kk = 2.0 * u_N / 3.14159265;
  vec2 b = vec2(dot(kk / (w * w + su * su) * (w * F[1] - su * F[0]), a), dot(kk / (w * w + sv * sv) * (w * F[2] - sv * F[0]), a));
  float l = length(b);
  return sphTurn(l > 1e-6 ? b / l : vec2(1.0, 0.0), 4 - k);
}
