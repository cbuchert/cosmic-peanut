#version 300 es
// Tiled Sphere: the p4 tiling on a cube-sphere, seen from outside or from inside. Each pixel's
// ray hits the unit sphere; the hit's face (largest component) gives the equal-angle face plane
// [0, N]² (src/lib/cube-sphere.js, mirrored and tested there). Across an edge two faces' planes
// differ by a quarter turn and whole-face translation, a symmetry of the p4 warp, so the tiles
// carry on. S is the face chart's analytic Jacobian times the screen derivatives of the hit
// point, which are smooth across faces, so outlines keep their weight over the edges. Tiles are
// recoloured by the face that owns them (TESS_CLASS) and ringed by angle from a pole (TESS_RING).
//
// With relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the height
// pass) the tiles are the carved block lifting off the globe: the sphere is displaced along its
// normal by the block's height × u_dispK (outward from outside, inward towards the camera from
// inside). The height pass writes the six faces' charts (each a margin wider) into a 3 × 2 atlas;
// each pixel then marches its ray through the shell between the skin and the height bound
// u_tRelief.z (a few steps by how many height texels the ray crosses, then bisection), prints the
// block where it lands and lights it with the raking light: the carving's normal, a soft shadow
// marched towards the light, the grooves darker. The hooks key a tile's hashes by its owner and turn
// its card away from the pole (sphere.glsl sphCell, sphFlipDir), so the relief is continuous across
// the cube's edges like the colouring.
precision highp float;

in vec2 v_uv;
out vec4 o;

// #include sphere

#define TESS_CLASS(cls, c) sphClass(cls, c)
#define TESS_RING(c) sphRing(c)
#ifdef TESS_RELIEF
#define TESS_FLIP_DIR(c) sphFlipDir(c)
#define TESS_CELL(cell, c) sphCell(c)
#if !defined(TESS_HEIGHT_PASS) && (defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC))
// The engine's exact cut sides (tessRefineHit): the exact block minus the ray's height at t.
float sphRaySolid(float t);
#define TESS_RAY_SOLID(t) sphRaySolid(t)
#endif
#endif
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

#ifdef TESS_RELIEF
uniform sampler2D u_tHeight;   // the faces' heights / u_tRelief.z, a 3 × 2 atlas of charts
uniform vec2 u_tHeightTexel;   // 1 / its size
uniform float u_dispK;         // world units per plane unit of height (lib/sphere-view.js reliefScale)
uniform vec3 u_rlight;         // towards the raking light, world, unit (lib/sphere-view.js viewLight)
#define ATLAS_MARGIN 0.06      // plane units of each chart beyond its face's edges, for filtering

int sphFaceOf(vec3 d) {
  vec3 a = abs(d);
  return a.x >= a.y && a.x >= a.z ? (d.x >= 0.0 ? 0 : 1) : a.y >= a.z ? (d.y >= 0.0 ? 2 : 3) : (d.z >= 0.0 ? 4 : 5);
}

vec2 sphChart(int f, vec3 d) {
  mat3 F = u_frame[f];
  return 0.5 * u_N * (1.0 + atan(vec2(dot(d, F[1]), dot(d, F[2])) / dot(d, F[0])) / 0.785398163);
}

// Texels per atlas cell, for a texture of the given size: face f is cell (f mod 3, f / 3).
vec2 atlasCell(vec2 size) { return floor(size / vec2(3.0, 2.0)); }

#ifndef TESS_HEIGHT_PASS
// Height (plane units) of the block over sphere direction d (any length), from the height pass.
float heightAt(vec3 d) {
  int f = sphFaceOf(d);
  vec2 p = sphChart(f, d);
  vec2 cell = atlasCell(1.0 / u_tHeightTexel);
  vec2 t = (p + ATLAS_MARGIN) / (u_N + 2.0 * ATLAS_MARGIN);
  vec2 uv = (vec2(float(f % 3), float(f / 3)) * cell + 0.5 + t * (cell - 1.0)) * u_tHeightTexel;
  return texture(u_tHeight, uv).r * u_tRelief.z;
}

// Below the carved surface (≤ 0): the shell's solid side of the displaced skin, world units.
float solid(vec3 P, float sg) {
  float r = length(P);
  return sg * (r - 1.0) - u_dispK * heightAt(P);
}
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
// The ray through the shell (sphere frame) from g_rPA to g_rPB, the tiles' side g_rSg.
vec3 g_rPA;
vec3 g_rPB;
float g_rSg;
float sphRaySolid(float t) {
  vec3 P = mix(g_rPA, g_rPB, t);
  vec3 d = normalize(P);
  g_face = sphFaceOf(d);
  return u_dispK * tessRelief(sphChart(g_face, d), mat2(1e-4)).x - g_rSg * (length(P) - 1.0);
}
#endif
#ifdef TESS_CINEMATIC
// The cinematic Look's horizon AO reads the height map round the direction g_aoD: an offset o in
// plane units along the face chart's axes (g_aoU, g_aoV) turns the direction by o · π / 2N.
vec3 g_aoD;
vec3 g_aoU;
vec3 g_aoV;
#define TESS_AO_HEIGHT(o) heightAt(g_aoD + ((o).x * g_aoU + (o).y * g_aoV) * (1.5707963 / u_N))
#define AO_RADIUS 0.12
#endif
#endif
#endif
// #include look

#if defined(TESS_HEIGHT_PASS)
void main() {
  vec2 cell = atlasCell(u_res);
  vec2 px = floor(gl_FragCoord.xy);
  vec2 fc = floor(px / cell);
  if (fc.x > 2.0 || fc.y > 1.0) {
    o = vec4(0.0);
    return;
  }
  g_face = int(fc.x + 3.0 * fc.y);
  vec2 p = -ATLAS_MARGIN + (u_N + 2.0 * ATLAS_MARGIN) * (px - fc * cell) / (cell - 1.0);
  // Tiles are never too small to carve here (the fade by footprint is for screen-space surfaces).
  float h = tessRelief(p, mat2(1e-4)).x;
  o = vec4(h / max(u_tRelief.z, 1e-6), 0.0, 0.0, 1.0);
}
#elif defined(TESS_RELIEF)
void main() {
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * u_res.y);
  vec3 rd = normalize(u_cam * vec3(s * u_tanHalf, 1.0));
  float b = dot(u_eye, rd);
  vec3 close = u_eye - b * rd;
  float disc = 1.0 - dot(close, close);
  float sq = sqrt(max(disc, 0.0));
  bool inside = u_inside > 0.5;
  // The skin's hit, as without relief: its screen derivatives give S, smooth over the edges.
  vec3 hw = disc > 0.0 ? u_eye + (inside ? -b + sq : -b - sq) * rd : normalize(close);
  vec3 h0 = normalize(u_rot * hw);
  vec3 dhx = dFdx(h0);
  vec3 dhy = dFdy(h0);
  float edge = length(close) - 1.0;
  float pw = max(fwidth(edge), 1e-6);                // a pixel, world units, near the limb

  float sg = inside ? -1.0 : 1.0;                    // the tiles lift towards the camera
  float H = u_tRelief.z;
  float A = u_dispK * H;                             // the shell's depth (world)
  vec3 eo = u_rot * u_eye;
  vec3 dr = u_rot * rd;
  // The ray through the shell: from the bound (radius 1 ± A) to the skin, or out of the shell again.
  float tA = 0.0;
  float tB = 0.0;
  bool seg = true;
  if (!inside) {
    float D1 = b * b - (dot(eo, eo) - (1.0 + A) * (1.0 + A));
    seg = D1 > 0.0;
    tA = -b - sqrt(max(D1, 0.0));
    tB = disc > 0.0 ? -b - sq : -b + sqrt(max(D1, 0.0));
  } else {
    float R0 = max(1.0 - A, 0.0);
    tA = -b + sqrt(max(b * b - (dot(eo, eo) - R0 * R0), 0.0));
    tB = -b + sq;
  }
  // Steps by the height texels the ray's footprint crosses: few looking straight at the skin.
  vec2 cell = atlasCell(1.0 / u_tHeightTexel);
  float texel = (u_N + 2.0 * ATLAS_MARGIN) / (cell.y - 1.0) * 1.5707963 / u_N;   // a texel, rad
  vec3 PA = eo + tA * dr;
  vec3 PB = eo + tB * dr;
  float span = acos(clamp(dot(normalize(PA), normalize(PB)), -1.0, 1.0)) / texel;
  int n = seg ? int(clamp(ceil(span / 4.0), 1.0, 12.0)) : 0;
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t0 = 0.0;
  float t1 = 1.0;
  bool hit = false;
  // A miss's nearest clearance (world); past the shell, the skin's own limb (antialiased as flat).
  float gmin = seg ? 1e9 : max(edge, 0.0);
  float tmin = 1.0;
  for (int i = 1; i <= 16; i++) {
    if (i > n) break;
    float t = min(1.0, (float(i) - jit + 0.5) / float(n));
    float g = solid(mix(PA, PB, t), sg);
    if (g <= 0.0) { t1 = t; hit = true; break; }
    if (g < gmin) { gmin = g; tmin = t; }
    t0 = t;
  }
  // A ray that reaches the skin ends on solid ground (heights are ≥ 0): its last stretch holds the hit.
  if (!hit && seg && (inside || disc > 0.0)) {
    t1 = 1.0;
    hit = true;
  }
  if (hit) {
    for (int i = 0; i < 5; i++) {
      float t = 0.5 * (t0 + t1);
      if (solid(mix(PA, PB, t), sg) <= 0.0) t1 = t; else t0 = t;
    }
  } else {
    t1 = tmin;
  }
  vec3 P = seg ? mix(PA, PB, t1) : normalize(u_rot * close);
  float cover = inside || hit ? 1.0 : clamp(0.5 - gmin / pw, 0.0, 1.0);

  vec3 paper = u_tPaper;
  vec3 bg = paper;
  if (!inside) {
    // A soft shadow under the floating sphere, down and to the right.
    float rr = length(s - vec2(0.05, -0.08) * u_discR) / max(u_discR, 1e-3);
    bg *= 1.0 - 0.12 * (1.0 - smoothstep(0.75, 1.35, rr));
  }
  // The paper round the sphere skips the print (most of the frame outside). Only quads straddling
  // the silhouette mix the two, where the print's fine-carving derivatives barely show.
  if (cover <= 0.0) {
#ifdef TESS_CINEMATIC
    o = vec4(mix(bg, paper, u_veil), tessCoC(1e6));
#else
    o = vec4(mix(bg, paper, u_veil), 1.0);
#endif
    return;
  }

  // The point's face chart and S (the chart's Jacobian times the skin's screen derivatives).
  float r = length(P);
  vec3 dir = P / r;
  g_face = sphFaceOf(dir);
  mat3 F = u_frame[g_face];
  float w = dot(dir, F[0]);
  float su = dot(dir, F[1]);
  float sv = dot(dir, F[2]);
  vec2 p = 0.5 * u_N * (1.0 + atan(vec2(su, sv) / w) / 0.785398163);
  float kk = 2.0 * u_N / 3.14159265;
  vec3 ju = kk / (w * w + su * su) * (w * F[1] - su * F[0]);
  vec3 jv = kk / (w * w + sv * sv) * (w * F[2] - sv * F[0]);
  mat2 S = mat2(dot(ju, dhx), dot(jv, dhx), dot(ju, dhy), dot(jv, dhy));

  TessPlate pl;
  float detail;
  vec4 c = tessShadeRelief(p, S, pl, detail);
  // The fine carving's slope from its screen derivatives (gouges cut, features raised).
  vec2 gd = abs(determinant(S)) > 1e-14 ? inverse(transpose(S)) * vec2(dFdx(detail), dFdy(detail)) : vec2(0.0);
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
  // Off the exact block (the map's ramp at a cut side), while cards turn: find the side exactly
  // (tessRefineHit) and print there; a hit under a block's top is its cut side.
  float under = 0.0;
  float hp0 = sg * (r - 1.0) / max(u_dispK, 1e-6);
  if (TESS_REFINE_ON && tessTurning(pl) && hit && u_dispK > 0.0 && abs(hp0 - pl.h) > 0.004) {
    g_rPA = PA;
    g_rPB = PB;
    g_rSg = sg;
    float span = 2.0 * texel / max(acos(clamp(dot(normalize(PA), normalize(PB)), -1.0, 1.0)), 1e-6);
    float tr = tessRefineHit(max(0.0, t1 - span), min(1.0, t1 + span));
    if (tr >= 0.0) {
      P = mix(PA, PB, tr);
      r = length(P);
      dir = P / r;
      g_face = sphFaceOf(dir);
      F = u_frame[g_face];
      w = dot(dir, F[0]);
      su = dot(dir, F[1]);
      sv = dot(dir, F[2]);
      p = 0.5 * u_N * (1.0 + atan(vec2(su, sv) / w) / 0.785398163);
      ju = kk / (w * w + su * su) * (w * F[1] - su * F[0]);
      jv = kk / (w * w + sv * sv) * (w * F[2] - sv * F[0]);
      S = mat2(dot(ju, dhx), dot(jv, dhx), dot(ju, dhy), dot(jv, dhy));
      c = tessShadeRelief(p, S, pl, detail);
      gd = vec2(0.0);
      under = dot(pl.grad, pl.grad) > 1e-8 ? smoothstep(0.004, 0.014, pl.h - sg * (r - 1.0) / u_dispK) : 0.0;
    } else {
      g_face = sphFaceOf(dir);
    }
  }
#endif
  vec2 gr = pl.grad + gd;
  vec3 n0 = sg * dir;                                // the skin's normal, on the camera's side
  vec3 N = normalize(n0 - u_dispK * (gr.x * ju + gr.y * jv));
  float hp = sg * (r - 1.0) / max(u_dispK, 1e-6);    // the hit's height over the skin, plane units
  // Where the ray met the side of a taller neighbour the wall's normal comes from the height field.
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
  float wall = u_dispK > 0.0 ? max(smoothstep(0.004, 0.014, hp - pl.h), under) : 0.0;
#else
  float wall = u_dispK > 0.0 ? smoothstep(0.004, 0.014, hp - pl.h) : 0.0;
#endif
  if (wall > 0.0) {
    vec3 tu = normalize(F[1] - dir * su);
    vec3 tv = normalize(F[2] - dir * sv);
    float e = 2.0 * texel;
    vec2 g = vec2(heightAt(dir + e * tu) - heightAt(dir - e * tu), heightAt(dir + e * tv) - heightAt(dir - e * tv));
    vec3 Nw = normalize(-(g.x * tu + g.y * tv) + n0 * (0.25 * length(g) + 1e-4));
#if defined(TESS_EXACT_SIDES) || defined(TESS_CINEMATIC)
    // On an exact cut side it faces out across the tile's outline.
    if (under > 0.0) {
      vec2 gn = normalize(pl.grad);
      Nw = normalize(-(gn.x * normalize(ju) + gn.y * normalize(jv)) + n0 * 0.15);
    }
#endif
    N = normalize(mix(N, Nw, wall));
#ifndef TESS_CINEMATIC
    c.rgb *= 1.0 - 0.45 * wall;                      // the block's cut side, in the shade of its top
#endif
  }

  vec3 L = u_rot * u_rlight;
  float up = dot(n0, L);                             // the light's height over the skin here
  // Soft shadow: march towards the light until out of the shell (none where the light is low).
  float shadow = 1.0;
  float reach = up > 0.05 ? max(A - sg * (r - 1.0), 0.0) / up : 0.0;
  float tw = texel;                                  // a texel, world (on the unit sphere)
  int ns = int(clamp(ceil(reach / tw / 4.0), 0.0, 8.0));
#ifdef TESS_CINEMATIC
  ns = tessShadowSteps(ns);
#endif
  for (int i = 1; i <= 8; i++) {
    if (i > ns) break;
    float t = reach * ((float(i) - jit) / float(ns)) + tw;
    float clear = solid(P + L * t, sg);
    shadow = min(shadow, clamp(0.5 + 6.0 * clear / t, 0.0, 1.0));
  }
  shadow = smoothstep(0.0, 1.0, shadow);
  // A flat top where the light stands high prints at its colour; towards the terminator it darkens.
  float diff = max(dot(N, L), 0.0) / max(up, 0.5);
  float zRef = u_tRelief.x * RELIEF_BLOCK;
  float ao = 0.72 + 0.28 * smoothstep(0.0, max(zRef, 1e-4), hp);
  float shade = 0.42 + 0.58 * min(diff * shadow, 1.6);
  float sheen = pow(max(dot(reflect(-L, N), -dr), 0.0), 24.0) * shadow * 0.08;
  float ndv = abs(dot(dir, dr));
  float limb = inside ? 0.82 + 0.18 * ndv : 1.0 - 0.38 * pow(1.0 - ndv, 2.0);

#ifdef TESS_CINEMATIC
  // Physically based print materials (look.glsl), horizon AO from the charts' heights, the
  // circle of confusion (depth along the view) in alpha.
  g_aoD = dir;
  g_aoU = normalize(F[1] - dir * su);
  g_aoV = normalize(F[2] - dir * sv);
  ao = tessHorizonAO(hp, pl.grad, AO_RADIUS, jit);
  float px = sqrt(abs(determinant(S)));
  vec3 col = tessLookShade(c.rgb, g_tessPaper, wall, tessWood(wall, vec3(p, hp), px), N, n0, -dr, L, shadow, ao, 0.42, 0.58, max(up, 0.5)) * limb;
  col = mix(bg, col, cover);
  o = vec4(mix(col, paper, u_veil), tessCoC(seg ? mix(tA, tB, t1) * dot(rd, u_cam[2]) : 1e6));
#else
  vec3 col = c.rgb * shade * ao * limb + sheen;
  col = mix(bg, col, cover);
  o = vec4(mix(col, paper, u_veil), 1.0);
#endif
}
#else
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
#ifdef TESS_CINEMATIC
  o = vec4(mix(col, paper, u_veil), tessCoC(disc > 0.0 ? (inside ? -b + sq : -b - sq) * dot(rd, u_cam[2]) : 1e6));
#else
  o = vec4(mix(col, paper, u_veil), 1.0);
#endif
}
#endif
