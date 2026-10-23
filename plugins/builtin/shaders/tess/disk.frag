#version 300 es
// Poincaré Disk surface: the tiling is a {p,q} tiling of the hyperbolic plane, seen in the
// Poincaré disk, its kites warped into interlocking creatures; the engine prints them
// (tessPrint). src/lib/tess-disk.js mirrors every step here and is tested.
//
// Per pixel: the disk point w → the view T (a drifting isometry, rebased on the CPU) → fold into
// the fundamental triangle T, tracking the quotient matrix E (for the colour), the parity, the
// differential (for the print's pixel scale) and the screen centre's image (for the rings) →
// the frame (an odd fold ends with the mirror a, so the frame map is a rotation) → the chart of
// the diamond round the edge midpoint M (translate M to 0, Klein, scale to the square
// [−1, 1]²) → the creature warp (odd under the half-turn about M) → which of the diamond's four
// kites, its uv (a homography per quadrant) and its colour (one texel of the quotient table).
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;
out vec4 o;

// Ring hook: a tile's centre is carried as (its pseudo-distance |w| from the screen centre, 0),
// so its ring is its hyperbolic distance from the centre over u_ringR: fronts spread to the rim.
uniform float u_ringR;
float diskRing(vec2 c) { return clamp(2.0 * atanh(min(c.x, 0.9999999)) / u_ringR, 0.0, 1.0); }
#define TESS_RING(c) diskRing(c)

// #include tess

uniform vec2 u_res;           // target size (px)
uniform vec3 u_disk;          // disk centre (target px), radius (target px)
uniform vec4 u_M0;            // view T: a.re, a.im, b.re, b.im
uniform vec4 u_M1;            //         c.re, c.im, d.re, d.im
uniform float u_conj;         // 1: T conjugates first (never, while the view rebases by rotations)
uniform vec2 u_O;             // T(0)
uniform vec3 u_tile;          // α = π/p, centre x and radius of the circle C
uniform int u_gR;             // the quotient's prime
uniform int u_gP;             // p
uniform ivec4 u_gRho[8];      // ρ^k, k = 0 … p − 1 (2×2 mod r, row-major)
uniform ivec4 u_gA;
uniform ivec4 u_gB;
uniform ivec4 u_gC;
uniform ivec4 u_gE0;          // the view's rebase record: the fold starts here
uniform usampler2D u_gCol;    // r² × r²: per matrix, the classes of the four kites round M
uniform vec3 u_chart;         // m (M on the real axis), the rhombus half-diagonals km, kv
uniform mat3 u_H[4];          // per quadrant: square chart → its kite's uv
uniform vec2 u_cK[4];         // per quadrant: its kite's centre in the frame
uniform vec2 u_wA[8];         // warp amplitude per mode
uniform float u_kiteA;        // √(kite area), hyperbolic

const int FOLD_ITERATIONS = 60;
const int DISK_STEPS = 4;
const float HP = 1.57079632679;
const ivec2 DISK_MODES[8] = ivec2[8](ivec2(1, 2), ivec2(2, 1), ivec2(2, 3), ivec2(3, 2),
                                    ivec2(1, 4), ivec2(4, 1), ivec2(3, 4), ivec2(4, 3));

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }
vec2 cconj(vec2 a) { return vec2(a.x, -a.y); }
mat2 cmat(vec2 u) { return mat2(u.x, u.y, -u.y, u.x); }

ivec4 gmul(ivec4 x, ivec4 y) {
  return ivec4((x.x * y.x + x.y * y.z) % u_gR, (x.x * y.y + x.y * y.w) % u_gR,
               (x.z * y.x + x.w * y.z) % u_gR, (x.z * y.y + x.w * y.w) % u_gR);
}

// |a − b| / |1 − ā b|: tanh of half the hyperbolic distance.
float pdist(vec2 a, vec2 b) { return length(a - b) / length(vec2(1.0, 0.0) - cmul(cconj(a), b)); }

// One warp step's displacement and Jacobian (tess-disk.js diskFieldAt).
vec2 diskField(vec2 p, out mat2 J) {
  float cs = cos(HP * p.x);
  float ct = cos(HP * p.y);
  float W = cs * cs * ct * ct;
  vec2 gW = vec2(-HP * sin(2.0 * HP * p.x) * ct * ct, -HP * cs * cs * sin(2.0 * HP * p.y));
  vec2 f = vec2(0.0);
  mat2 Jf = mat2(0.0);
  for (int j = 0; j < 8; j++) {
    float n = float(DISK_MODES[j].x) * HP;
    float m = float(DISK_MODES[j].y) * HP;
    float a1 = n * (p.x + 1.0);
    float a2 = m * (p.y + 1.0);
    float sn = sin(a1);
    float sm = sin(a2);
    f += u_wA[j] * (sn * sm);
    Jf += outerProduct(u_wA[j], vec2(n * cos(a1) * sm, m * sn * cos(a2)));
  }
  J = W * Jf + outerProduct(f, gW);
  return W * f;
}

int quadrant(vec2 q) {
  float sx = q.x + q.y; // ∝ chart Klein x
  float sy = q.x - q.y; // ∝ chart Klein y
  return sx < 0.0 ? (sy > 0.0 ? 0 : 1) : (sy > 0.0 ? 2 : 3);
}

vec4 diskShade(vec2 w, float tileSize) {
  // z = T(w), and T′(w).
  vec2 wc = u_conj > 0.5 ? cconj(w) : w;
  vec2 den = cmul(u_M1.xy, wc) + u_M1.zw;
  vec2 z = cdiv(cmul(u_M0.xy, wc) + u_M0.zw, den);
  vec2 Tp = cdiv(cmul(u_M0.xy, u_M1.zw) - cmul(u_M0.zw, u_M1.xy), cmul(den, den));

  // Fold (hyperbolic.js fold): dz0 = D·dz (even) or D·conj(dz) (odd).
  float a = u_tile.x;
  float cx = u_tile.y;
  float cr2 = u_tile.z * u_tile.z;
  float a2 = 2.0 * a;
  vec2 mir = vec2(cos(a2), sin(a2));
  ivec4 E = u_gE0;
  bool odd = false;
  vec2 D = vec2(1.0, 0.0);
  vec2 oz = u_O;
  for (int i = 0; i < FOLD_ITERATIONS; i++) {
    float k = floor(atan(z.y, z.x) / a2);
    if (k != 0.0) {
      vec2 rt = vec2(cos(-k * a2), sin(-k * a2));
      z = cmul(rt, z);
      oz = cmul(rt, oz);
      D = cmul(rt, D);
      E = gmul(E, u_gRho[int(mod(k, float(u_gP)))]);
    }
    if (atan(z.y, z.x) > a) {
      z = cmul(mir, cconj(z));
      oz = cmul(mir, cconj(oz));
      D = cmul(mir, cconj(D));
      odd = !odd;
      E = gmul(E, u_gB);
    }
    vec2 dz = z - vec2(cx, 0.0);
    float d2 = dot(dz, dz);
    if (d2 >= cr2) break;
    vec2 zb = cconj(dz);
    D = cmul(cdiv(vec2(-cr2, 0.0), cmul(zb, zb)), cconj(D));
    z = vec2(cx, 0.0) + dz * (cr2 / d2);
    vec2 od = oz - vec2(cx, 0.0);
    oz = vec2(cx, 0.0) + od * (cr2 / dot(od, od));
    odd = !odd;
    E = gmul(E, u_gC);
  }
  if (odd) {
    z = cconj(z);
    oz = cconj(oz);
    D = cconj(D);
    E = gmul(E, u_gA);
  }

  // Chart: ζ = (z − m) / (1 − m z), Klein, the square. P = dζ/dpixel.
  float m = u_chart.x;
  vec2 dd = vec2(1.0, 0.0) - m * z;
  vec2 zeta = cdiv(z - vec2(m, 0.0), dd);
  vec2 phiP = cdiv(vec2(1.0 - m * m, 0.0), cmul(dd, dd));
  mat2 P = cmat(cmul(cmul(phiP, D), Tp) / u_disk.z);
  if (u_conj > 0.5) P = P * mat2(1.0, 0.0, 0.0, -1.0);
  float rz = 1.0 + dot(zeta, zeta);
  vec2 k = zeta * (2.0 / rz);
  mat2 DK = mat2(2.0 / rz) - outerProduct(zeta, zeta) * (4.0 / (rz * rz));
  mat2 A = mat2(1.0 / u_chart.y, 1.0 / u_chart.y, 1.0 / u_chart.z, -1.0 / u_chart.z);
  vec2 q = A * k;
  mat2 Q = A * DK * P;                              // d(s, t)/dpixel

  // The creature warp.
  mat2 Jw = mat2(1.0);
  for (int i = 0; i < DISK_STEPS; i++) {
    mat2 Jd;
    q += diskField(q, Jd);
    Jw = (mat2(1.0) + Jd) * Jw;
  }
  mat2 Qw = Jw * Q;

  // The kite: quadrant, uv, colour.
  int quad = quadrant(q);
  mat3 H = u_H[quad];
  vec3 hq = H * vec3(q, 1.0);
  vec2 uv = hq.xy / hq.z;
  mat2 DH = mat2(H[0][0] - uv.x * H[0][2], H[0][1] - uv.y * H[0][2],
                 H[1][0] - uv.x * H[1][2], H[1][1] - uv.y * H[1][2]) / hq.z;
  mat2 M = 0.5 * DH * Qw;                           // dq/dpixel, q = uv / 2 (tiles 0.5 across)
  // Row a·r + b, column c·r + d: lib/tess-disk.js matIndex, row-major.
  uvec4 cls = texelFetch(u_gCol, ivec2(E.z * u_gR + E.w, E.x * u_gR + E.y), 0);

  Tile t;
  t.uv = uv;
  t.cls = int(cls[quad]);
  t.orient = quad;
  t.centre = vec2(pdist(oz, u_cK[quad]), 0.0);
  t.cell = vec2(0.0);
  tessEdges(t, vec2(1.0, 0.0), vec2(0.0, 1.0));
  // The colour block, out of register: the quadrant at the offset point (to first order).
  int qf = quadrant(q + Qw * (u_tReg * u_tPxScale));
  Tile tf = t;
  tf.cls = int(cls[qf]);
  tf.centre = vec2(pdist(oz, u_cK[qf]), 0.0);

  float pxq = sqrt(abs(determinant(M)));
  float dpx = t.dist / max(length(transpose(M) * t.n), 1e-9);
  return tessPrint(t, tf, pxq, tileSize, dpx, 0.0, 0.5 * uv);
}

void main() {
  vec2 w = (gl_FragCoord.xy - u_disk.xy) / u_disk.z;
  float rw = length(w);
  float fpx = 1.0 / u_tPxScale;
  // A kite's size in target px from the disk's metric (2|dw| / (1 − |w|²)): one size per tile
  // for the print's fades, smooth across the kite.
  float tileSize = rw < 1.0 ? 0.5 * u_kiteA * u_disk.z * (1.0 - rw * rw) : 0.0;
  vec3 col = u_tInk;
  // Tiles below about a pixel print as ink (the crowded rim); don't fold for them.
  if (tileSize > 0.6 * fpx) col = mix(u_tInk, diskShade(w, tileSize).rgb, smoothstep(0.6 * fpx, 1.6 * fpx, tileSize));
  // The disk's edge, antialiased, onto the paper.
  col = mix(u_tPaper, col, clamp((1.0 - rw) * u_disk.z + 0.5, 0.0, 1.0));
  o = vec4(col, 1.0);
}
