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
