// The cube-sphere's chart, tile owners, colours and rings (src/lib/cube-sphere.js mirrors them),
// for the surfaces that show the sphere's tiling: sphere.frag (Tiled Sphere) and disk3d.frag (the
// tiled wall round the Poincaré Disk's coin). Spliced in with `// #include sphere`, before the
// engine (its hooks use these). The surface sets g_face to the face of the point it shades.

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

