#version 300 es
// Endless Zoom: the tiling seen through a log-polar map, p = α log z + O, so it spirals into the
// vanishing point without end. One turn round the centre moves p by the lattice vector α·2πi
// (src/lib/tess-zoom.js spiralVector), so the tiles close across the angle's seam; zooming slides
// O along α. S is the map's analytic Jacobian (α / z per px), not dFdx, which would see the seam.
//
// With relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the height
// pass) the plane is the carved block seen through the same map. The height pass writes the
// block's height over the view (a margin wider); then each pixel marches its view ray down through
// it. The map is conformal, so locally it is a similarity by α / z: heights and slopes in plane
// units carry over unchanged, and a ray that leans by ZOOM_LEAN radially outward in plane units
// runs along log r, which is a translation of the plane along α. So relief and parallax scale with
// the tiles at every radius (the view is self-similar under the zoom) and nothing depends on the
// angle, so there is no seam. Lit by a raking light fixed to the screen, with a soft shadow, as
// Metamorphosis. Relief fades out where tiles get too small to carve, near the vanishing point.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec2 u_O;       // plane offset (wrapped by whole blend periods)
uniform vec2 u_alpha;   // complex scale α
uniform vec3 u_ring;    // ring span in log radius: lo, hi; 1 = flip (edge → centre)

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// A tile's ring by the log radius of its centre: Re((c − O) / α). Constant round each turn,
// so it agrees across the seam; fronts ripple along the spiral.
float zoomRing(vec2 c) {
  float lr = dot(c - u_O, u_alpha) / dot(u_alpha, u_alpha);
  float r = clamp((lr - u_ring.x) / (u_ring.y - u_ring.x), 0.0, 1.0);
  return u_ring.z > 0.5 ? 1.0 - r : r;
}
#define TESS_RING(c) zoomRing(c)

#ifdef TESS_RELIEF
uniform vec4 u_cellKey; // the wraps' cell base (xy) and one turn's cell shift (zw): lib/tess-zoom.js
// A tile's id reduced modulo one turn (mirrors lib/tess-zoom.js cellKey, tested there), so its
// lift variation and pops agree across the seam and through the offset's wraps.
vec2 zoomCellKey(vec2 cell) {
  vec2 k = cell + u_cellKey.xy;
  return k - u_cellKey.zw * floor((k.x + 0.5) / u_cellKey.z);
}
#define TESS_CELL_KEY(cell) zoomCellKey(cell)
// Cards turn over radially (along α in the plane): the same direction round every turn.
#define TESS_FLIP_DIR(c) normalize(u_alpha)
#if !defined(TESS_HEIGHT_PASS) && (defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC))
// The engine's exact cut sides (tessRefineHit): the exact block minus the ray's height at t.
float zoomRaySolid(float t);
#define TESS_RAY_SOLID(t) zoomRaySolid(t)
#endif
#endif

// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec2 u_vp;      // vanishing point, screen units (half the short side) from the centre
uniform vec3 u_vanish;  // soft vanishing point: inner, outer radius (screen units); 0 ink … 1 paper

#ifdef TESS_RELIEF
#define HEIGHT_MARGIN 1.12
// View rays lean this far radially outward per unit of descent (plane units, as if from above
// the vanishing point), so the blocks show their sides facing the centre.
#define ZOOM_LEAN 0.5
// Relief fades out as tiles shrink from RELIEF_FADE.y to RELIEF_FADE.x full-resolution px.
#define RELIEF_FADE vec2(12.0, 48.0)
uniform float u_hsFull;        // full-resolution px per screen unit (half the short side)
uniform vec3 u_light;          // towards the light, screen frame (x right, y up, z out of the block)

// The plane point at z (relative to the vanishing point, screen units)…
vec2 zoomP(vec2 z) {
  float r2 = max(dot(z, z), 1e-12);
  return cmul(u_alpha, vec2(0.5 * log(r2), atan(z.y, z.x))) + u_O;
}
// …and dp/dz there (per screen unit), α / z as a matrix.
mat2 zoomJ(vec2 z) {
  vec2 az = cmul(u_alpha, vec2(z.x, -z.y)) / max(dot(z, z), 1e-12);
  return mat2(az.x, az.y, -az.y, az.x);
}
// 1 where tiles are large enough to carve, 0 near the vanishing point.
float zoomReliefFade(vec2 z) {
  float tile = 0.5 * length(z) / length(u_alpha) * u_hsFull;   // a tile's size, full-res px
  return smoothstep(RELIEF_FADE.x, RELIEF_FADE.y, tile);
}

#ifndef TESS_HEIGHT_PASS
uniform sampler2D u_tHeight;   // height / u_tRelief.z over the view × HEIGHT_MARGIN
uniform vec2 u_tHeightTexel;   // 1 / its size

// Height (plane units) at z, from the height pass.
float heightAt(vec2 z) {
  vec2 uv = 0.5 + 0.5 * (z + u_vp) / HEIGHT_MARGIN * min(u_res.x, u_res.y) / u_res;
  return texture(u_tHeight, uv).r * u_tRelief.z;
}
#ifdef TESS_CINEMATIC
// The cinematic Look's horizon AO reads the height map round the shading point g_aoZ: offsets in
// plane units (screen-turned) are g_aoK screen units each there.
vec2 g_aoZ;
float g_aoK;
#define TESS_AO_HEIGHT(o) heightAt(g_aoZ + (o) * g_aoK)
#define AO_RADIUS 0.12
#endif
#endif
#endif
// #include look

#if defined(TESS_RELIEF) && !defined(TESS_HEIGHT_PASS) && (defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC))
// The ray through z0, by log-radius offset from sA (at the bound H) to sB (at the floor).
vec2 g_rz0;
vec3 g_rs;   // sA, sB, H
float zoomRaySolid(float t) {
  vec2 z = g_rz0 * exp(mix(g_rs.x, g_rs.y, t));
  float hs = 0.5 * min(u_res.x, u_res.y);
  return tessRelief(zoomP(z), zoomJ(z) / hs).x * zoomReliefFade(z) - mix(g_rs.z, 0.0, t);
}
#endif

void main() {
  float hs = 0.5 * min(u_res.x, u_res.y);
#if defined(TESS_HEIGHT_PASS)
  vec2 z = (gl_FragCoord.xy - 0.5 * u_res) / hs * HEIGHT_MARGIN - u_vp;
  // S per print-target px (not this target's), so the engine's fade agrees with the print's.
  float h = tessRelief(zoomP(z), zoomJ(z) / (u_hsFull * u_tPxScale)).x * zoomReliefFade(z);
  o = vec4(h / max(u_tRelief.z, 1e-6), 0.0, 0.0, 1.0);
#elif defined(TESS_RELIEF)
  vec2 z0 = (gl_FragCoord.xy - 0.5 * u_res) / hs - u_vp;
  float r0 = max(length(z0), 1e-6);
  float la = length(u_alpha);
  float H = u_tRelief.z;
  float zRef = u_tRelief.x * RELIEF_BLOCK * zoomReliefFade(z0); // resting tops print where the flat print has them
  // The ray through (z0, zRef), by log-radius offset: at s it is at z0 e^s, zRef − s |α| / lean.
  float sA = (zRef - H) * ZOOM_LEAN / la;       // at the bound (further in)
  float sB = zRef * ZOOM_LEAN / la;             // at the floor (further out)
  float texel = 2.0 * HEIGHT_MARGIN * max(u_tHeightTexel.x, u_tHeightTexel.y); // screen units
  float lean = r0 * (exp(sB) - exp(sA)) / texel; // height texels the ray crosses going down
  int n = int(clamp(ceil(lean / 3.0), 1.0, 16.0));
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t0 = 0.0;
  float t1 = 1.0;
  for (int i = 1; i <= 16; i++) {
    if (i > n) break;
    float t = min(1.0, (float(i) - jit + 0.5) / float(n));
    if (heightAt(z0 * exp(mix(sA, sB, t))) >= mix(H, 0.0, t)) { t1 = t; break; }
    t0 = t;
  }
  for (int i = 0; i < 5; i++) {
    float t = 0.5 * (t0 + t1);
    if (heightAt(z0 * exp(mix(sA, sB, t))) >= mix(H, 0.0, t)) t1 = t; else t0 = t;
  }
  vec2 Z = z0 * exp(mix(sA, sB, t1));
  float Pz = mix(H, 0.0, t1);
  float rz = max(length(Z), 1e-6);
  float kf = zoomReliefFade(Z);

  mat2 S = zoomJ(Z) / hs;                        // dp/dpixel at the hit: the analytic Jacobian
  TessPlate pl;
  float detail;
  vec4 c = tessShadeRelief(zoomP(Z), S, pl, detail);
  pl.h *= kf;
  pl.grad *= kf;
  detail *= kf;
  // The fine carving's slope from its screen derivatives (gouges cut, features raised); then the
  // plane slope turned into the screen frame (a similarity: slopes carry over, turned by arg α/z).
  vec2 gd = inverse(transpose(S)) * vec2(dFdx(detail), dFdy(detail));
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
  // Off the exact block (the map's ramp at a cut side): find the side exactly (tessRefineHit; in
  // classic while cards turn, always in cinematic); a hit under a block's top is its cut side.
  float under = 0.0;
  if (abs(Pz - pl.h) > 0.004) {
    g_rz0 = z0;
    g_rs = vec3(sA, sB, H);
    float span = 2.0 * texel / max(r0 * (exp(sB) - exp(sA)), 1e-6);
    float tr = tessRefineHit(max(0.0, t1 - span), min(1.0, t1 + span));
    if (tr >= 0.0) {
      Z = z0 * exp(mix(sA, sB, tr));
      Pz = mix(H, 0.0, tr);
      rz = max(length(Z), 1e-6);
      kf = zoomReliefFade(Z);
      S = zoomJ(Z) / hs;
      c = tessShadeRelief(zoomP(Z), S, pl, detail);
      pl.h *= kf;
      pl.grad *= kf;
      gd = vec2(0.0);
      under = dot(pl.grad, pl.grad) > 1e-8 ? smoothstep(0.004, 0.014, pl.h - Pz) : 0.0;
    }
  }
  vec2 u = normalize(cmul(u_alpha, vec2(Z.x, -Z.y)));
  vec2 gp = pl.grad + gd;
  vec3 N = normalize(vec3(-dot(gp, u), -dot(gp, vec2(-u.y, u.x)), 1.0));
  float wall = max(smoothstep(0.004, 0.014, Pz - pl.h), under);
#else
  vec2 u = normalize(cmul(u_alpha, vec2(Z.x, -Z.y)));
  vec2 gp = pl.grad + gd;
  vec3 N = normalize(vec3(-dot(gp, u), -dot(gp, vec2(-u.y, u.x)), 1.0));
  // Where the ray met the side of a taller neighbour the wall's normal comes from the field.
  float wall = smoothstep(0.004, 0.014, Pz - pl.h);
#endif
  if (wall > 0.0) {
    vec2 e = vec2(texel, 0.0);
    vec2 g = vec2(heightAt(Z + e.xy) - heightAt(Z - e.xy), heightAt(Z + e.yx) - heightAt(Z - e.yx));
    vec3 Nw = normalize(vec3(-g, 0.25 * length(g) + 1e-4));
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
    // On an exact cut side it faces out across the tile's outline (turned into the screen frame).
    if (under > 0.0) {
      vec2 gn = normalize(pl.grad);
      Nw = normalize(vec3(-dot(gn, u), -dot(gn, vec2(-u.y, u.x)), 0.15));
    }
#endif
    N = normalize(mix(N, Nw, wall));
#ifndef TESS_CINEMATIC
    c.rgb *= 1.0 - 0.45 * wall;                  // the block's cut side, in the shade of its top
#endif
  }

  vec3 L = u_light;
  // Soft shadow towards the light: t plane units along L cross t |Z| / |α| screen units.
  float shadow = 1.0;
  float k = rz / la;
  float reach = max(H - Pz, 0.0) / L.z;
  int ns = int(clamp(ceil(reach * length(L.xy) * k / texel / 4.0), 0.0, 8.0));
#ifdef TESS_CINEMATIC
  ns = tessShadowSteps(ns);
#endif
  for (int i = 1; i <= 8; i++) {
    if (i > ns) break;
    float t = reach * ((float(i) - jit) / float(ns)) + texel / k;
    float clear = Pz + L.z * t - heightAt(Z + L.xy * (t * k));
    shadow = min(shadow, clamp(0.5 + 6.0 * clear / t, 0.0, 1.0));
  }
  shadow = smoothstep(0.0, 1.0, shadow);
#ifdef TESS_CINEMATIC
  // Physically based print materials (look.glsl) and horizon AO from the map, in the screen frame.
  vec3 V = normalize(vec3(-(Z / rz) * ZOOM_LEAN, 1.0));
  g_aoZ = Z;
  g_aoK = k;
  float ao = mix(1.0, tessHorizonAO(Pz, vec2(dot(pl.grad, u), dot(pl.grad, vec2(-u.y, u.x))), AO_RADIUS, jit), kf);
  float px = sqrt(abs(determinant(S)));
  o = vec4(tessLookShade(c.rgb, g_tessPaper, wall, tessWood(wall, vec3(zoomP(Z), Pz), px), N, vec3(0.0, 0.0, 1.0), V, L, shadow, ao, 0.36, 0.64, L.z), 1.0);
#else
  float diff = max(dot(N, L), 0.0) / L.z;        // a flat top in full light prints as it is
  float ao = 1.0 - 0.28 * kf * (1.0 - smoothstep(0.0, 1.0, Pz / max(zRef, 1e-6)));
  float shade = 0.36 + 0.64 * min(diff * shadow, 1.6);
  vec3 V = normalize(vec3(-(Z / rz) * ZOOM_LEAN, 1.0));
  float sheen = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * shadow * 0.08;
  o = vec4(c.rgb * shade * ao + sheen, 1.0);
#endif
  // Tiles too small to print fade (in the engine) to their mean; then into a soft point.
  float kv = 1.0 - smoothstep(u_vanish.x, u_vanish.y, r0);
  o.rgb = mix(o.rgb, mix(u_tInk, u_tPaper, u_vanish.z), kv * kv);
#else
  vec2 z = (gl_FragCoord.xy - 0.5 * u_res) / hs - u_vp;
  float r2 = max(dot(z, z), 1e-12);
  vec2 w = vec2(0.5 * log(r2), atan(z.y, z.x));
  vec2 az = cmul(u_alpha, vec2(z.x, -z.y)) / (r2 * hs); // dp/dpixel = α / z / hs
  o = tessShade(cmul(u_alpha, w) + u_O, mat2(az.x, az.y, -az.y, az.x));
  // Tiles too small to print fade (in the engine) to their mean; then into a soft point.
  float k = 1.0 - smoothstep(u_vanish.x, u_vanish.y, sqrt(r2));
  o.rgb = mix(o.rgb, mix(u_tInk, u_tPaper, u_vanish.z), k * k);
#endif
}
