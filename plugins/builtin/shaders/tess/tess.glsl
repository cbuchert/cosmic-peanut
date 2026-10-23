// Tiling engine and print look shared by the tessellation visualizers, spliced in where a
// surface shader says `// #include tess` (src/lib/tess-gl.js does the splice and uploads every
// u_t* uniform from src/lib/tess-music.js createTessState).
//
// The seam: a surface maps its pixel to a point p of the tiling plane and calls
//   vec4 tessShade(vec2 p, mat2 S)        S = dp/dpixel (target px), the map's Jacobian
//   vec4 tessShade(vec2 p, float px)      isotropic shorthand: S = px · I
// which returns the printed colour (linear RGB, a = 1). S makes ink lines, gouges and features
// a constant print weight in pixels however the map stretches the plane. Optional hook: define
// TESS_RING(c) before the include to give each tile its ring (0 near/centre … 1 far/edge, used
// by the figure/ground front and the spectrum rings); the default is the distance of the tile's
// centre c from u_tRing.xy over u_tRing.z. Optional hook: define TESS_CLASS(cls, c) to recolour a
// tile from its regular class and centre (0–2, an index into u_tCls; e.g. a surface whose charts
// meet with a turn that swaps the classes); the default keeps cls.
//
// Mirrors src/lib/tess.js (tested there): the symmetric displacement field (tessField ↔
// fieldAt), the regular tile test (tessTile ↔ tileAt). Plane units: the lattice (p4: unit
// squares; p3: unit hex lattice).
#define TESS_MAX 24
#define TAU 6.28318530718
#define S3 1.73205080757

uniform int u_tGroup;         // 0 = p4, 1 = p3
uniform int u_tN;        // symmetrized terms in use
uniform vec4 u_tK[TESS_MAX];  // per term: wave vector k, phase φ, 0
uniform vec4 u_tAB[TESS_MAX]; // per term: amplitude in set A (xy) and set B (zw)
uniform vec3 u_tBlend;        // spatial metamorphosis m(p) = ½ + ½ sin(2π k·p + φ): k.xy, φ

// d(p) = Σ mix(A, B, m(p)) cos(2π k·p + φ), with its Jacobian dd/dp, and m itself.
vec2 tessField(vec2 p, out mat2 J, out float m) {
  float ma = TAU * dot(u_tBlend.xy, p) + u_tBlend.z;
  m = 0.5 + 0.5 * sin(ma);
  vec2 gm = (0.5 * TAU * cos(ma)) * u_tBlend.xy;
  vec2 d = vec2(0.0);
  vec2 dd = vec2(0.0); // dB − dA
  J = mat2(0.0);
  for (int i = 0; i < TESS_MAX; i++) {
    if (i >= u_tN) break;
    vec4 k = u_tK[i];
    vec4 ab = u_tAB[i];
    float a = TAU * dot(k.xy, p) + k.z;
    float c = cos(a);
    float s = sin(a);
    vec2 am = mix(ab.xy, ab.zw, m);
    d += am * c;
    dd += (ab.zw - ab.xy) * c;
    J += outerProduct(am, (-TAU * s) * k.xy);
  }
  J += outerProduct(dd, gm);
  return d;
}

// The warp: TESS_STEPS steps of p + d(p), each a homeomorphism while the field's Lipschitz
// bound is under 1, so their composition is too; composing lets edges overhang into hooks and
// lobes that one small step can't reach. J = dq/dp; m = the blend at p.
#ifndef TESS_STEPS
#define TESS_STEPS 4
#endif
vec2 tessWarp(vec2 p, out mat2 J, out float m) {
  mat2 Ji;
  float mi;
  vec2 q = p + tessField(p, Ji, m);
  J = mat2(1.0) + Ji;
  for (int i = 1; i < TESS_STEPS; i++) {
    q += tessField(q, Ji, mi);
    J = (mat2(1.0) + Ji) * J;
  }
  return q;
}

struct Tile {
  int cls;      // colour class: 0–1 (p4) or 0–2 (p3)
  int orient;   // group rotations from the base tile
  vec2 uv;      // tile-local 0–1, turning with the tile
  float dist;   // distance to the tile's boundary (plane units)
  vec2 n;       // unit gradient of dist (inward)
  vec2 centre;  // the tile's centre
  vec2 cell;    // integer id (cell, or lattice point + class)
};

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

void tessEdges(inout Tile t, vec2 nu, vec2 nv) {
  float d = t.uv.x;
  vec2 n = nu;
  if (1.0 - t.uv.x < d) { d = 1.0 - t.uv.x; n = -nu; }
  if (t.uv.y < d) { d = t.uv.y; n = nv; }
  if (1.0 - t.uv.y < d) { d = 1.0 - t.uv.y; n = -nv; }
  t.dist = 0.5 * d;
  t.n = n;
}

Tile tessTile(vec2 q) {
  Tile t;
  if (u_tGroup == 0) {
    // p4: half-unit squares; the four around each integer point are its 90° turns.
    vec2 ij = floor(2.0 * q);
    vec2 par = mod(ij, 2.0);
    int o = par.x < 0.5 ? (par.y < 0.5 ? 0 : 3) : (par.y < 0.5 ? 1 : 2);
    vec2 corner = (ij + par) * 0.5;
    mat2 R = rot2(float(o) * (TAU / 4.0));
    vec2 l = (q - corner) * R; // R^T (q − corner) = R^−o r
    t.uv = 2.0 * l;
    t.orient = o;
    t.cls = int(par.x + par.y) & 1;
    t.cell = ij;
    t.centre = corner + R * vec2(0.25);
    tessEdges(t, R[0], R[1]);
    return t;
  }
  // p3: nearest lattice point, then which of its hexagon's three rhombi.
  float b = q.y / (0.5 * S3);
  float a = q.x - 0.5 * b;
  vec2 f = floor(vec2(a, b));
  vec2 best = f;
  float bd = 1e9;
  for (int i = 0; i < 4; i++) {
    vec2 c = f + vec2(float(i & 1), float(i >> 1));
    vec2 pc = vec2(c.x + 0.5 * c.y, 0.5 * S3 * c.y);
    float d2 = dot(q - pc, q - pc);
    if (d2 < bd) { bd = d2; best = c; }
  }
  vec2 L = vec2(best.x + 0.5 * best.y, 0.5 * S3 * best.y);
  vec2 r = q - L;
  float ang = mod(atan(r.y, r.x) - TAU / 12.0, TAU);
  int k = int(min(2.0, floor(ang / (TAU / 3.0))));
  mat2 R = rot2(float(k) * (TAU / 3.0));
  vec2 l = r * R;
  t.uv = vec2(l.x + S3 * l.y, S3 * l.y - l.x);
  t.orient = k;
  t.cls = k;
  t.cell = best * 3.0 + vec2(float(k), 0.0);
  t.centre = L + R * vec2(0.0, 0.5 / S3);
  tessEdges(t, R * vec2(0.5, 0.5 * S3), R * vec2(-0.5, 0.5 * S3));
  return t;
}

// ---- Print look ---------------------------------------------------------------------------

uniform vec3 u_tPaper;        // linear colours
uniform vec3 u_tInk;
uniform vec3 u_tCls[3];       // colour of each class now…
uniform vec3 u_tClsNext[3];   // …and after the figure/ground shift under way
uniform vec3 u_tAvg;          // mean tile colour, for tiles too small to draw
uniform vec3 u_tInvert;       // shift front (0–1 near → far), front width, 0
uniform float u_tInkW;        // outline half-width, full-resolution px
uniform float u_tHatch;       // gouge hatching 0–1
uniform vec2 u_tReg;          // colour-block registration offset, full-resolution px
uniform float u_tBands[16];   // spectrum per ring of tiles, 0–1
uniform vec4 u_tFeatA;        // feature weights where the blend is 0: eye, spine, fins, star
uniform vec4 u_tFeatB;        // …and where it is 1
uniform float u_tPxScale;     // target px per full-resolution px (render scale)
uniform vec3 u_tRing;         // default ring: origin.xy (plane), scale

float tessHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float tessNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tessHash12(i), tessHash12(i + vec2(1, 0)), f.x),
             mix(tessHash12(i + vec2(0, 1)), tessHash12(i + vec2(1, 1)), f.x), f.y);
}

// Antialiased band: 1 where |x| < w, with a 1-px soft edge (x, w in px).
float tessBand(float x, float w) { return clamp(w - abs(x) + 0.5, 0.0, 1.0); }

float tessRing(vec2 c) { return clamp(length(c - u_tRing.xy) / u_tRing.z, 0.0, 1.0); }
#ifndef TESS_RING
#define TESS_RING(c) tessRing(c)
#endif
#ifndef TESS_CLASS
#define TESS_CLASS(cls, c) (cls)
#endif

// Tile features in tile-local uv (they turn with the tile): a ringed eye, an arched spine,
// fin or feather strokes, a five-point rosette. uvPx = uv units per target px; fpx = target px
// per full-resolution px.
float tessFeatures(vec2 uv, vec4 feat, float uvPx, float fpx) {
  vec2 eye = vec2(0.70, 0.66);
  float de = length(uv - eye);
  float eyeRing = tessBand((de - 0.075) / uvPx, 1.2 * fpx);
  float pupil = clamp((0.035 - de) / uvPx + 0.5, 0.0, 1.0);
  float e = max(eyeRing, pupil) * feat.x;
  vec2 a = vec2(0.16, 0.22);
  vec2 b = vec2(0.58, 0.56);
  vec2 ab = b - a;
  vec2 nrm = normalize(vec2(-ab.y, ab.x));
  float h = clamp(dot(uv - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 sp = a + ab * h + vec2(-ab.y, ab.x) * 0.18 * h * (1.0 - h);
  float spine = tessBand(length(uv - sp) / uvPx, 1.3 * fpx) * feat.y * smoothstep(0.0, 0.15, h);
  float fins = 0.0;
  for (int i = 0; i < 3; i++) {
    float hh = 0.35 + 0.15 * float(i);
    vec2 c = a + ab * hh + vec2(-ab.y, ab.x) * 0.18 * hh * (1.0 - hh);
    vec2 d = uv - c;
    float along = dot(d, nrm);
    float across = dot(d, normalize(ab)) - 0.25 * along;
    fins = max(fins, tessBand(across / uvPx, 1.0 * fpx) * step(abs(along - 0.06), 0.07));
  }
  fins *= feat.z;
  vec2 dc = uv - vec2(0.42, 0.42);
  float rr = 0.06 + 0.025 * cos(5.0 * atan(dc.y, dc.x));
  float star = clamp((rr - length(dc)) / uvPx + 0.5, 0.0, 1.0) * feat.w;
  return max(max(e, spine), max(fins, star));
}

vec4 tessShade(vec2 p, mat2 S) {
  mat2 J;
  float m;
  vec2 q = tessWarp(p, J, m);
  mat2 M = J * S;                                  // dq / dpixel
  float pxq = sqrt(abs(determinant(M)));          // plane units per target px
  float fpx = 1.0 / u_tPxScale;                    // full-resolution px in target px
  Tile t = tessTile(q);
  float dpx = t.dist / max(length(transpose(M) * t.n), 1e-9); // to the outline, target px

  // Colour blocks, printed slightly out of register with the key block; the figure/ground
  // front sweeps across the rings, each tile easing between its colours.
  Tile tf = tessTile(q + M * (u_tReg * u_tPxScale));
  float fade = smoothstep(0.0, 1.0, clamp((u_tInvert.x - TESS_RING(tf.centre)) / u_tInvert.y + 0.5, 0.0, 1.0));
  int fc = TESS_CLASS(tf.cls, tf.centre);
  vec3 fill = mix(u_tCls[fc], u_tClsNext[fc], fade);
  bool dark = dot(fill, vec3(0.2126, 0.7152, 0.0722)) < 0.18;
  vec3 cut = dark ? u_tPaper : u_tInk;             // what a gouge or a feature shows
  float bandv = u_tBands[int(clamp(TESS_RING(t.centre) * 16.0, 0.0, 15.0))];
  float tileSize = 0.5 / pxq;                      // half a tile, target px
  vec3 col = fill;

  // Woodcut gouges: lines parallel to the outline (levels of the boundary distance), echoing it
  // inwards; width follows the tone, spacing and width this ring's band.
  if (u_tHatch > 0.0) {
    float spacing = 0.03 * (1.0 - 0.18 * bandv);
    float x = t.dist / spacing;
    float idx = floor(x);
    float lineW = (dark ? 0.26 : 0.16) * (0.75 + 0.5 * tessNoise(t.uv * 5.0 + vec2(float(t.orient) * 3.1, float(t.cls) * 7.3))) * (0.7 + 0.6 * bandv);
    float reach = mix(1.0, 6.0, u_tHatch);           // echo lines in from the edge
    float taper = 1.0 - smoothstep(reach - 1.0, reach + 0.5, idx);
    float fx = (fract(x) - 0.5) * spacing / pxq;
    float g = tessBand(fx, lineW * taper * spacing / pxq * 0.5) * step(0.5, idx);
    g *= smoothstep(1.8, 4.0, spacing / pxq);        // fade before the lines alias
    col = mix(col, cut, g * min(1.0, u_tHatch * 1.6));
  }

  vec4 feat = mix(u_tFeatA, u_tFeatB, m);
  float f = tessFeatures(t.uv, feat, 2.0 * pxq, fpx);
  col = mix(col, cut, f * smoothstep(6.0 * fpx, 16.0 * fpx, tileSize));

  // Key block: bold outlines, a little ink spread where the paper takes more.
  float spread = 1.0 + 0.22 * (tessNoise(q * 9.0) - 0.5) + 0.12 * (tessNoise(gl_FragCoord.xy * 0.35) - 0.5);
  col = mix(col, u_tInk, tessBand(dpx, u_tInkW * spread * fpx));

  // Tiles too small to print fade to their mean.
  col = mix(u_tAvg, col, smoothstep(3.0 * fpx, 10.0 * fpx, tileSize));
  return vec4(col, 1.0);
}

vec4 tessShade(vec2 p, float px) { return tessShade(p, mat2(px)); }
