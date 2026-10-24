// The atlas motif: bestiary tiles (plugins/builtin/tiles) printed with the engine's look.
// Spliced in after tess.glsl when a surface defines TESS_ATLAS (lib/tess-gl.js); u_tMotif picks
// it per frame (0 = the warp's abstract creatures, unchanged; 1 = the atlas). The tile comes
// from a periodic cell texture baked by shaders/tess/atlas-bake.frag whenever the tile changes
// (lib/atlas-gl.js): outline distance and gradient, which copy of the tile, the interior art's
// role and edge distance. Sampling uses analytic lattice derivatives (textureGrad), so it is
// seamless across the cell and mip-filtered when tiles are small; edges are antialiased from
// distances in target px, so outlines and art stay crisp at any magnification.

uniform sampler2D u_aField;   // RGBA16F: outline distance (plane), inward unit normal, height
uniform sampler2D u_aArt;     // RGBA16F: art edge distance (plane), its normal, packed id·8 + role
uniform vec2 u_aRes;          // atlas size (texels)
uniform mat2 u_aL;            // lattice → tile frame
uniform mat2 u_aLinv;         // tile frame → lattice
uniform float u_aInv;         // tile-frame units per plane unit
uniform vec4 u_aCopyInv[4];   // per copy: world → base frame (column-major)
uniform vec4 u_aCopyOff[4];   // per copy: offset xy, class, 0
uniform vec2 u_aCtr[4];       // per copy: centroid (tile frame)
uniform vec3 u_aCls;          // class step along a, along b, classes
uniform vec3 u_aAccent[2];    // accent colour now / after the figure/ground shift (linear)
uniform float u_aDip;         // print → its mean colour during a change of tile type

// What tessPrint's art hook reads for the pixel being shaded (set by tessAtlasShade).
int g_aRole;        // art role here (0 = the tile's own fill)
int g_aRole2;       // the role across the nearest art edge
float g_aCov;       // coverage of g_aRole against g_aRole2 (antialiased edge)
float g_aHeight;    // relief hint (for surfaces that light it)

// The packed atlas id at lattice point c (any cell): copy, cell offset, role.
ivec4 tessAtlasId(vec2 c) {
  vec2 f = fract(c);
  ivec2 tx = clamp(ivec2(f * u_aRes), ivec2(0), ivec2(u_aRes) - 1);
  int v = int(texelFetch(u_aArt, tx, 0).w + 0.5);
  int id = v >> 3;
  return ivec4(id / 25, (id / 5) % 5 - 2, id % 5 - 2, v & 7);
}

// The Tile (tess.glsl) the id names, at lattice cell `cell`; q = the tile-frame point.
Tile tessAtlasTile(ivec4 id, vec2 cell, vec2 q) {
  Tile t;
  int k = id.x;
  vec2 tc = cell + vec2(id.yz);
  t.cls = int(mod(u_aCopyOff[k].z + tc.x * u_aCls.x + tc.y * u_aCls.y, u_aCls.z));
  t.orient = k;
  mat2 inv = mat2(u_aCopyInv[k].xy, u_aCopyInv[k].zw);
  vec2 base = u_aL * tc;
  t.uv = inv * (q - base) + u_aCopyOff[k].xy;
  t.centre = (base + u_aCtr[k]) / u_aInv;
  t.cell = tc * 4.0 + vec2(float(k), 0.0);
  t.dist = 0.0;
  t.n = vec2(0.0, 1.0);
  return t;
}

// The colour of an art role over the tile's printed fill `col`.
vec3 tessArtRole(int role, vec3 col, vec3 cut, float fade) {
  if (role == 1) return u_tInk;
  if (role == 2) return u_tPaper;
  if (role == 3) return cut;
  if (role == 4) return mix(u_aAccent[0], u_aAccent[1], fade);
  if (role == 5) return mix(col, u_tInk, 0.45);
  if (role == 6) return mix(col, u_tPaper, 0.5);
  return col;
}

// tessPrint's hook: print the interior art over the fill (after the gouges, before the key block).
vec3 tessArt(vec3 col, vec3 fill, vec3 cut, float fade, float tileSize, float fpx) {
  if (u_tMotif != 1) return col;
  vec3 own = tessArtRole(g_aRole, col, cut, fade);
  vec3 other = tessArtRole(g_aRole2, col, cut, fade);
  vec3 art = mix(other, own, g_aCov);
  return mix(col, art, smoothstep(6.0 * fpx, 16.0 * fpx, tileSize));
}

vec4 tessAtlasShade(vec2 p, mat2 S) {
  vec2 q = p * u_aInv;                     // tile frame
  mat2 Mq = S * u_aInv;                    // d(tile frame) / d(target px)
  vec2 c = u_aLinv * q;                    // lattice
  vec2 cell = floor(c);
  mat2 G = u_aLinv * Mq;                   // d(lattice) / d(target px): seamless derivatives
  vec2 f = c - cell;
  vec4 fld = textureGrad(u_aField, f, G[0], G[1]);
  vec4 art = textureGrad(u_aArt, f, G[0], G[1]);
  ivec4 id = tessAtlasId(c);

  Tile t = tessAtlasTile(id, cell, q);
  t.dist = fld.x;
  t.n = length(fld.yz) > 1e-6 ? normalize(fld.yz) : vec2(0.0, 1.0);
  vec2 q2 = q + Mq * (u_tReg * u_tPxScale);
  vec2 c2 = u_aLinv * q2;
  Tile tf = tessAtlasTile(tessAtlasId(c2), floor(c2), q2);

  float pxq = sqrt(abs(determinant(S)));   // plane units per target px
  float dpx = t.dist / max(length(transpose(S) * t.n), 1e-9);

  // The art edge: this side's role, the role across it, and the coverage in target px.
  vec2 an = length(art.yz) > 1e-6 ? normalize(art.yz) : vec2(0.0, 1.0);
  float apx = art.x / max(length(transpose(S) * an), 1e-9);
  vec2 across = q - an * (art.x * u_aInv + 1.5 * length(u_aL[0]) / u_aRes.x);
  ivec4 id2 = tessAtlasId(u_aLinv * across);
  g_aRole = id.w;
  g_aRole2 = id2.xyz == id.xyz ? id2.w : id.w;
  g_aCov = clamp(0.5 + apx, 0.0, 1.0);
  g_aHeight = fld.w;

  vec4 o = tessPrint(t, tf, pxq, 0.5 / pxq, dpx, 0.0, p);
  o.rgb = mix(o.rgb, u_tAvg, u_aDip);
  return o;
}

#ifdef TESS_ATLAS_RELIEF
// ---- Relief: the animals carved (tess.glsl tessPlate / tessShadeRelief call these) ----------

// The animal tile at plane point p (footprint S = dp/dpixel), its outline distance and inward
// normal, and the bake's relief hint there with its gradient dh/dp (central differences a texel,
// or a pixel when that is wider, apart; the hint is continuous, ~0 at every outline).
Tile tessAtlasPlateTile(vec2 p, mat2 S, out float hint, out vec2 hintGrad) {
  vec2 q = p * u_aInv;                     // tile frame
  vec2 c = u_aLinv * q;                    // lattice
  vec2 cell = floor(c);
  vec2 f = c - cell;
  mat2 G = u_aLinv * (S * u_aInv);         // d(lattice) / d(target px)
  vec4 fld = textureGrad(u_aField, f, G[0], G[1]);
  Tile t = tessAtlasTile(tessAtlasId(c), cell, q);
  t.dist = fld.x;
  t.n = length(fld.yz) > 1e-6 ? normalize(fld.yz) : vec2(0.0, 1.0);
  hint = fld.w;
  float e = max(length(u_aL[0]) / u_aRes.x, max(length(S[0]), length(S[1])) * u_aInv); // tile frame
  vec2 ex = u_aLinv[0] * e;                // lattice step for +e along the tile frame's x…
  vec2 ey = u_aLinv[1] * e;                // …and y
  float hx = textureGrad(u_aField, f + ex, G[0], G[1]).w - textureGrad(u_aField, f - ex, G[0], G[1]).w;
  float hy = textureGrad(u_aField, f + ey, G[0], G[1]).w - textureGrad(u_aField, f - ey, G[0], G[1]).w;
  hintGrad = vec2(hx, hy) * (u_aInv / (2.0 * e));
  return t;
}

void tessAtlasArtAt(vec2 p, mat2 S);
#define ATLAS_HINT 0.5   // block per unit of relief hint on an animal's top (lib/atlas.js)

// tess.glsl tessPlate for the animals (u_tMotif 1): the plane is unwarped, each animal lifts,
// pops and turns over as a whole card (its ring and hash from its own centre and id), its bevel
// follows its outline, and its top is raised and carved by the bake's relief hint (lib/atlas.js
// atlasBlock: profile × (1 + ATLAS_HINT · hint), so the groove stays at the floor). Through a
// change of tile type everything lays down with the print's dip, so the swap of outlines and
// tile ids never jumps.
TessPlate tessAtlasPlate(vec2 p, mat2 S, out vec2 at) {
  TessPlate r;
  float hint;
  vec2 hg;
  r.t = tessAtlasPlateTile(p, S, hint, hg);
  r.m = 0.0;
  r.J = mat2(1.0);
  at = p;
  float ring = TESS_RING(r.t.centre);
  float fade = smoothstep(0.0, 1.0, clamp((u_tInvert.x - ring) / u_tInvert.y + 0.5, 0.0, 1.0));
  float th = 3.14159265 * fade;
  float sn = sin(th);
  float cs = cos(th);
  float lift = u_tRelief.x * (tessLiftAt(ring) * (1.0 - LIFT_VARY + 2.0 * LIFT_VARY * tessHash12(r.t.cell * 0.731 + 3.7)) + tessPopAt(r.t.cell, ring));
  r.face = cs < 0.0 ? 1.0 : 0.0;
  r.pit = 0.0;
  float ac = 1.0;
  float h = lift;
  vec2 gq = vec2(0.0);   // dh/dp of the card's tilt
  mat2 C = mat2(1.0);    // d(card point)/dp
  if (sn > 1e-3) {
    vec2 b = TESS_FLIP_DIR(r.t.centre);
    ac = max(abs(cs), 0.02);
    float x = dot(p - r.t.centre, b);
    float xc = x / ac;
    vec2 pc = p + b * (xc - x);
    C = mat2(1.0) + outerProduct(b, b) * (1.0 / ac - 1.0);
    Tile t2 = tessAtlasPlateTile(pc, C * S, hint, hg);
    if (t2.cell != r.t.cell) {
      r.pit = 1.0;
      r.h = 0.0;
      r.grad = vec2(0.0);
      r.prof = 0.0;
      return r;
    }
    r.t = t2;
    at = pc;
    float sg = cs >= 0.0 ? 1.0 : -1.0;
    h += CARD_RISE * (sn * (CARD_HALF + u_tRelief.w) + clamp(xc, -CARD_HALF, CARD_HALF) * sn * sg);
    gq = abs(xc) < CARD_HALF ? (CARD_RISE * sn * sg / ac) * b : vec2(0.0);
    r.J = C;
  }
  float slope;
  r.prof = tessProfile(r.t.dist, slope);
  float blk = u_tRelief.x * RELIEF_BLOCK * ac;
  float k = 1.0 + ATLAS_HINT * hint;
  h += blk * r.prof * k;
  r.grad = gq + blk * (C * ((slope * k) * r.t.n + (r.prof * ATLAS_HINT) * hg));
  float lay = 1.0 - u_aDip;
  h *= lay;
  r.grad *= lay;
  if (h <= 0.0) r.grad = vec2(0.0);
  r.h = clamp(h, 0.0, u_tRelief.z);
  return r;
}

// tess.glsl tessRelief for the animals: height and dh/dp.
vec3 tessAtlasRelief(vec2 p, mat2 S) {
  vec2 at;
  TessPlate r = tessAtlasPlate(p, S, at);
  float k = tessReliefFade(r.J, S);
  return vec3(r.h * k, r.grad * k);
}

// tess.glsl tessShadeRelief for the animals: the print on the carved block at p, its plate, and
// the fine carving (gouges cut) for the surface's normals.
vec4 tessAtlasShadeRelief(vec2 p, mat2 S, out TessPlate r, out float detail) {
  vec2 at;
  r = tessAtlasPlate(p, S, at);
  detail = 0.0;
  mat2 M = r.J * S;
  float pxq = sqrt(abs(determinant(M)));
  float k = tessReliefFade(r.J, S);
  r.h *= k;
  r.grad *= k;
  if (r.pit > 0.5) return vec4(mix(u_tInk, u_tPaper, 0.22), 1.0);
  Tile t = r.t;
  float dpx = t.dist / max(length(transpose(M) * t.n), 1e-9);
  // No registration offset or cross-fade on the block: the card's face picks the colour.
  int fc = TESS_CLASS(t.cls, t.centre);
  vec3 fill = r.face > 0.5 ? u_tClsNext[fc] : u_tCls[fc];
  tessAtlasArtAt(at, M);                 // the animal's art, at the card's point
  vec2 marks;
  vec4 col = tessPrintFill(t, fill, r.face > 0.5 ? 1.0 : 0.0, pxq, 0.5 / pxq, dpx, 0.0, p, marks);
  col.rgb = mix(col.rgb, u_tAvg, u_aDip);
  detail = -GOUGE_DEPTH * marks.x * u_tRelief.x * k;
  return col;
}

// What tessPrint's art hook reads, for the animal's point p (plane) with footprint S: as
// tessAtlasShade does for the flat print.
void tessAtlasArtAt(vec2 p, mat2 S) {
  vec2 q = p * u_aInv;
  vec2 c = u_aLinv * q;
  vec2 cell = floor(c);
  mat2 G = u_aLinv * (S * u_aInv);
  vec4 art = textureGrad(u_aArt, c - cell, G[0], G[1]);
  ivec4 id = tessAtlasId(c);
  vec2 an = length(art.yz) > 1e-6 ? normalize(art.yz) : vec2(0.0, 1.0);
  float apx = art.x / max(length(transpose(S) * an), 1e-9);
  vec2 across = q - an * (art.x * u_aInv + 1.5 * length(u_aL[0]) / u_aRes.x);
  ivec4 id2 = tessAtlasId(u_aLinv * across);
  g_aRole = id.w;
  g_aRole2 = id2.xyz == id.xyz ? id2.w : id.w;
  g_aCov = clamp(0.5 + apx, 0.0, 1.0);
}
#endif
