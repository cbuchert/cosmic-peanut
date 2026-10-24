// The Poincaré Disk's tiling, per pixel, for the surfaces that show it (disk.frag, the flat
// print; disk3d.frag, the coin's face): spliced in after the engine with `// #include disk`.
// src/lib/tess-disk.js mirrors every step and is tested.
//
// diskShade(w, …): the disk point w → the view T (a drifting isometry, rebased on the CPU) →
// fold into the fundamental triangle T, tracking the quotient matrix E (for the colour), the
// parity, the differential (for the print's pixel scale) and the screen centre's image (for the
// rings) → the frame (an odd fold ends with the mirror a, so the frame map is a rotation) → the
// chart of the diamond round the edge midpoint M (translate M to 0, Klein, scale to the square
// [−1, 1]²) → the creature warp (odd under the half-turn about M) → which of the diamond's four
// kites, its uv (a homography per quadrant) and its colour (one texel of the quotient table).
// The surface declares u_disk (centre and radius of the disk, target px) before the include.

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

// What diskShade found, for a surface that lights the print (disk3d.frag): the tile's
// pseudo-distance from the face's centre and (with DISK_IMPACT) from the beat's impact, its
// boundary distance (plane units, as the print's gouges), px to its outline and the outline's
// direction on screen, its uv.
struct DiskOut {
  float centreD;
  float impactD;
  float dist;
  float dpx;
  vec2 edge;
  vec2 uv;
#ifdef TESS_RELIEF
  float prevD;                // …from the previous beat's impact (DISK_IMPACT)
  int id;                     // the kite's id in the quotient (lib/tess-disk.js kiteIds)
  vec2 wc;                    // the kite's centre on the face (disk point)
#endif
};
DiskOut g_dk;
#ifdef DISK_IMPACT
uniform vec2 u_I;             // the beat's impact (tiling point), folded with the pixel
#endif
#if defined(DISK_IMPACT) && defined(TESS_RELIEF)
#define DISK_PREV
uniform vec2 u_I2;            // the previous beat's impact, likewise (its ripple runs out)
#endif
#ifdef TESS_RELIEF
uniform highp usampler2D u_gId; // r² × r²: per matrix, the ids of the four kites round M
#endif

// The kite under a disk point, everything the print needs: the tile, the colour block's tile
// (out of register), plane units per target px, px to the outline, dq/dpixel.
struct DiskKite {
  Tile t;
  Tile tf;
  float pxq;
  float dpx;
  mat2 M;
};

// w: the disk point; R: target px per disk unit; Jpx: dw/dpixel × R (the identity on the flat
// print, where w is the pixel over R; the face's perspective elsewhere).
DiskKite diskKite(vec2 w, float R, mat2 Jpx) {
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
#ifdef DISK_IMPACT
  vec2 iz = u_I;
#endif
#ifdef DISK_PREV
  vec2 jz = u_I2;
#endif
  for (int i = 0; i < FOLD_ITERATIONS; i++) {
    float k = floor(atan(z.y, z.x) / a2);
    if (k != 0.0) {
      vec2 rt = vec2(cos(-k * a2), sin(-k * a2));
      z = cmul(rt, z);
      oz = cmul(rt, oz);
#ifdef DISK_IMPACT
      iz = cmul(rt, iz);
#endif
#ifdef DISK_PREV
      jz = cmul(rt, jz);
#endif
      D = cmul(rt, D);
      E = gmul(E, u_gRho[int(mod(k, float(u_gP)))]);
    }
    if (atan(z.y, z.x) > a) {
      z = cmul(mir, cconj(z));
      oz = cmul(mir, cconj(oz));
#ifdef DISK_IMPACT
      iz = cmul(mir, cconj(iz));
#endif
#ifdef DISK_PREV
      jz = cmul(mir, cconj(jz));
#endif
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
#ifdef DISK_IMPACT
    vec2 id = iz - vec2(cx, 0.0);
    iz = vec2(cx, 0.0) + id * (cr2 / dot(id, id));
#endif
#ifdef DISK_PREV
    vec2 jd = jz - vec2(cx, 0.0);
    jz = vec2(cx, 0.0) + jd * (cr2 / dot(jd, jd));
#endif
    odd = !odd;
    E = gmul(E, u_gC);
  }
  if (odd) {
    z = cconj(z);
    oz = cconj(oz);
#ifdef DISK_IMPACT
    iz = cconj(iz);
#endif
#ifdef DISK_PREV
    jz = cconj(jz);
#endif
    D = cconj(D);
    E = gmul(E, u_gA);
  }

  // Chart: ζ = (z − m) / (1 − m z), Klein, the square. P = dζ/dpixel.
  float m = u_chart.x;
  vec2 dd = vec2(1.0, 0.0) - m * z;
  vec2 zeta = cdiv(z - vec2(m, 0.0), dd);
  vec2 phiP = cdiv(vec2(1.0 - m * m, 0.0), cmul(dd, dd));
  mat2 P = cmat(cmul(cmul(phiP, D), Tp) / R);
  if (u_conj > 0.5) P = P * mat2(1.0, 0.0, 0.0, -1.0);
  P = P * Jpx;
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
  g_dk.centreD = t.centre.x;
#ifdef DISK_IMPACT
  g_dk.impactD = pdist(iz, u_cK[quad]);
#else
  g_dk.impactD = 1.0;
#endif
  g_dk.dist = t.dist;
  g_dk.dpx = dpx;
  g_dk.edge = transpose(M) * t.n;
  g_dk.uv = uv;
#ifdef TESS_RELIEF
#ifdef DISK_PREV
  g_dk.prevD = pdist(jz, u_cK[quad]);
#else
  g_dk.prevD = 1.0;
#endif
  uvec4 ids = texelFetch(u_gId, ivec2(E.z * u_gR + E.w, E.x * u_gR + E.y), 0);
  g_dk.id = int(ids[quad]);
  // Φ (face → frame) is w ↦ (u w + o) / (1 + ō u w), o = Φ(0) = oz; Φ′(w) = D T′(w) gives u, and
  // Φ⁻¹ takes the kite's centre back to the face (lib/tess-disk.js faceCentre).
  vec2 oc = cconj(oz);
  vec2 az = vec2(1.0, 0.0) - cmul(oc, z);
  vec2 uk = cdiv(cmul(D, Tp) * (1.0 - dot(oz, oz)), cmul(az, az));
  vec2 ck = u_cK[quad];
  g_dk.wc = cdiv(ck - oz, cmul(uk, vec2(1.0, 0.0) - cmul(oc, ck)));
#endif
  DiskKite dk;
  dk.t = t;
  dk.tf = tf;
  dk.pxq = pxq;
  dk.dpx = dpx;
  dk.M = M;
  return dk;
}

// The rim: the print fades kites under 10 → 3 px to the palette's mean (tessPrintFill), and
// under 1.6 → 0.6 px to ink, so the four-block palette's olive mean stood as a wide, muddy band
// between the detail and the ink. A tiny kite is mostly its outline (the ink keeps its width in
// px as the kite shrinks), so its mean darkens towards ink with the outline's share of it, about
// RIM_INK × the ink width over its size: the detail fades through a darkening tone into the ink
// (1.6: all ink at 1.6 px, where the surfaces hand a kite over to ink).
#define RIM_INK 1.6
vec3 diskRimFade(vec3 col, float tileSize, float fpx) {
  float mean = 1.0 - smoothstep(3.0 * fpx, 10.0 * fpx, tileSize);   // tessPrintFill's fade
  float ink = clamp(RIM_INK * u_tInkW * fpx / max(tileSize, 1e-6), 0.0, 1.0);
  return col + (mean * ink) * (u_tInk - u_tAvg);
}

vec4 diskShade(vec2 w, float R, mat2 Jpx, float tileSize) {
  DiskKite dk = diskKite(w, R, Jpx);
  return tessPrint(dk.t, dk.tf, dk.pxq, tileSize, dk.dpx, 0.0, 0.5 * dk.t.uv);
}

#ifdef TESS_RELIEF
// ---- Relief: the kites carved like the engine's block (lib/disk-relief.js mirrors it) ---------
// Heights are world units (the face is the unit disk): tile units (the engine's, a kite half a
// unit across) times the kite's size there, √A (1 − |w|²). A resting top lies on the face plane,
// the outline's groove is cut below it by the engine's bevel-to-dome profile, the music lifts the
// whole kite (diskKiteLift, the surface's, tile units), and while the figure/ground front passes
// each kite turns over like a card about its axis radial from the face's centre (squeezed on the
// face, its back in the next colour). The carving fades out where a kite spans too few height
// texels (texel: disk units per texel of the height map), so the rim stays clean.
#define KITE_FADE_LO 3.0
#define KITE_FADE_HI 8.0
#define GOUGE_SLOPE 0.9
#define FEATURE_SLOPE 0.8

uniform vec2 u_kH;            // the height map's range: lowest height, span (world units)
#ifndef TESS_HEIGHT_PASS
uniform sampler2D u_tHeight;  // the face's height over the disk's square, (h − lo) / span
uniform vec2 u_tHeightTexel;
// The height map's height at disk point w (world units).
float diskHeightAt(vec2 w) { return u_kH.x + u_kH.y * texture(u_tHeight, 0.5 + 0.5 * w).r; }
#endif

float diskKiteLift();         // the surface's: the kite in g_dk's lift (tile units)

float diskFade(float scale, float texel) { return smoothstep(KITE_FADE_LO, KITE_FADE_HI, 0.5 * scale / texel); }

struct DiskRelief {
  DiskKite k;   // the kite at the point (on a turning card: at the card's own point)
  float h;      // height above the face plane (world units)
  vec2 grad;    // dh/dw
  float prof;   // block profile 0 (groove) … 1 (top)
  float face;   // 0 front (u_tCls), 1 back (u_tClsNext)
  float pit;    // 1 where a card has turned up off its bed and the bed shows
  float lift;   // the kite's lift (tile units)
  float kPx;    // the carving's fade here
  float scale;  // the kite's size (world units per tile unit, at its centre)
};

DiskRelief diskRelief(vec2 w, float R, mat2 Jpx, float texel) {
  DiskRelief r;
  r.k = diskKite(w, R, Jpx);
  float sPx = u_kiteA * max(0.0, 1.0 - dot(w, w));
  r.kPx = diskFade(sPx, texel);
  float cd = g_dk.centreD;
  r.scale = u_kiteA * max(0.0, 1.0 - cd * cd);
  float kT = diskFade(r.scale, texel);
  float ring = TESS_RING(vec2(cd, 0.0));
  float fade = smoothstep(0.0, 1.0, clamp((u_tInvert.x - ring) / u_tInvert.y + 0.5, 0.0, 1.0));
  float th = 3.14159265 * fade;
  float sn = sin(th);
  float cs = cos(th);
  r.lift = max(diskKiteLift(), 0.0);
  r.face = cs < 0.0 ? 1.0 : 0.0;
  r.pit = 0.0;
  float blk = u_tRelief.x * RELIEF_BLOCK * sPx * r.kPx;
  float ac = 1.0;
  float card = 0.0;
  vec2 gc = vec2(0.0);
  if (sn > 1e-3 && kT > 0.0) {
    // The card: the kite squeezed by |cos θ| across its axis about its centre on the face; the
    // pixel shows the card's point w + b (x/|cos θ| − x), if that is still this kite.
    float lw = length(g_dk.wc);
    vec2 b = lw > 1e-4 ? g_dk.wc / lw : vec2(1.0, 0.0);
    ac = max(abs(cs), 0.02);
    float x = dot(w - g_dk.wc, b);
    float xc = x / ac;
    vec2 w2 = w + b * (xc - x);
    mat2 C = mat2(1.0) + outerProduct(b, b) * (1.0 / ac - 1.0);
    int id0 = g_dk.id;
    DiskOut keep = g_dk;
    DiskKite k2 = diskKite(w2, R, C * Jpx);
    if (g_dk.id != id0 || dot(w2, w2) >= 1.0) {
      g_dk = keep;
      r.pit = 1.0;
      r.h = -blk;
      r.grad = vec2(0.0);
      r.prof = 0.0;
      return r;
    }
    r.k = k2;
    float sg = cs >= 0.0 ? 1.0 : -1.0;
    float xt = xc / max(r.scale, 1e-6);           // tile units across the axis
    card = CARD_RISE * (sn * (CARD_HALF + u_tRelief.w) + clamp(xt, -CARD_HALF, CARD_HALF) * sn * sg);
    gc = abs(xt) < CARD_HALF ? (kT * CARD_RISE * sn * sg / ac) * b : vec2(0.0);
  }
  float slope;
  r.prof = tessProfile(r.k.t.dist, slope);
  r.h = blk * (ac * r.prof - 1.0) + r.scale * kT * (r.lift + card);
  // ∇_w of the tile distance: dpixel → dw is Jpx / R.
  vec2 gd = R * (inverse(transpose(Jpx)) * g_dk.edge);
  r.grad = (blk * ac * slope) * gd + gc;
  return r;
}

// The fine carving's slope (dh/dw, for the normals only): each gouge a V cut across the hatching's
// line, the features' edges bevelled up. marks: tessPrintFill's gouge and feature coverage.
vec2 diskDetail(DiskRelief r, vec2 marks, float R, mat2 Jpx, float tileSize, float fpx) {
  Tile t = r.k.t;
  mat2 Wi = R * inverse(transpose(Jpx));            // ∇_pixel → ∇_w
  vec2 gd = Wi * g_dk.edge;
  float lg = length(gd);
  vec2 g = vec2(0.0);
  if (marks.x > 0.0 && lg > 0.0) {
    float bandv = u_tBands[int(clamp(TESS_RING(t.centre) * 16.0, 0.0, 15.0))];
    float x = t.dist / (0.03 * (1.0 - 0.18 * bandv));
    g += (fract(x) < 0.5 ? -1.0 : 1.0) * GOUGE_SLOPE * marks.x * (gd / lg);
  }
  float fs = smoothstep(6.0 * fpx, 16.0 * fpx, tileSize);
  if (marks.y > 0.0 && fs > 0.0) {
    float uvPx = 2.0 * r.k.pxq;
    float e = 1.5 * uvPx;
    float f0 = tessFeatures(t.uv, u_tFeatA, uvPx, fpx);
    vec2 gf = vec2(tessFeatures(t.uv + vec2(e, 0.0), u_tFeatA, uvPx, fpx) - f0,
                   tessFeatures(t.uv + vec2(0.0, e), u_tFeatA, uvPx, fpx) - f0) / e;
    vec2 gw = Wi * (2.0 * (transpose(r.k.M) * gf));  // uv = 2 q
    float l = length(gw);
    if (l > 0.0) g += FEATURE_SLOPE * 4.0 * f0 * (1.0 - f0) * fs * (gw / l);
  }
  return g;
}
#endif

