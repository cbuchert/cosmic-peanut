#version 300 es
// Metamorphosis, flat surface: the tiling fills the screen and drifts. The plane point is the
// pixel scaled and turned; S (dp/dpixel) is that scale and turn. Everything else is the engine.
//
// With relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the
// height pass) the plane is the carved block seen from a camera u_camD above it: the height pass
// writes the block's height over the view (a margin wider, for rays and shadows that lean out),
// then each pixel marches its perspective ray down through that height field (relief mapping:
// steps by how far the ray leans, refined by bisection), prints the block where it lands and
// lights it with a raking light: the carving's normal, a soft shadow marched towards the light,
// the grooves darker.
precision highp float;

in vec2 v_uv;
out vec4 o;

#define TESS_ATLAS
// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec2 u_O;       // plane point at the centre of the view
uniform vec2 u_rot;     // view rotation (cos, sin)
uniform float u_zoom;   // plane units per half the short side

#ifdef TESS_RELIEF
#define HEIGHT_MARGIN 1.12
uniform sampler2D u_tHeight;   // height / u_tRelief.z over the view × HEIGHT_MARGIN
uniform vec2 u_tHeightTexel;   // 1 / its size
uniform vec3 u_light;          // towards the light, view frame (x right, y up, z out of the block)
uniform float u_camD;          // camera height above the groove floor (plane units)

#ifndef TESS_HEIGHT_PASS
// Height (plane units) at a plane point, from the height pass.
float heightAt(vec2 p) {
  mat2 R = mat2(u_rot.x, u_rot.y, -u_rot.y, u_rot.x);
  vec2 sh = (p - u_O) * R / (u_zoom * HEIGHT_MARGIN);   // Rᵀ (p − O) in half-short-sides
  vec2 uv = 0.5 + 0.5 * sh * min(u_res.x, u_res.y) / u_res;
  return texture(u_tHeight, uv).r * u_tRelief.z;
}
#ifdef TESS_CINEMATIC
// The cinematic Look's horizon AO reads the height map round the shading point g_aoP.
vec2 g_aoP;
#define TESS_AO_HEIGHT(o) heightAt(g_aoP + (o))
#define AO_RADIUS 0.12
#endif
#endif
#endif
// #include look

void main() {
  float hs = 0.5 * min(u_res.x, u_res.y);
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / hs;
  mat2 R = mat2(u_rot.x, u_rot.y, -u_rot.y, u_rot.x);
#if defined(TESS_HEIGHT_PASS)
  float h = tessRelief(u_O + R * s * (u_zoom * HEIGHT_MARGIN), R * (u_zoom * HEIGHT_MARGIN / hs)).x;
  o = vec4(h / max(u_tRelief.z, 1e-6), 0.0, 0.0, 1.0);
#elif defined(TESS_RELIEF)
  float H = u_tRelief.z;
  float zRef = u_tRelief.x * RELIEF_BLOCK;      // resting tops stay where the flat print has them
  vec2 p0 = u_O + R * s * u_zoom;
  // The ray from the camera (above O) through (p0, zRef): A where it is at the bound, B at the floor.
  vec3 E = vec3(u_O, u_camD);
  vec3 dir = vec3(p0, zRef) - E;
  vec3 A = E + dir * ((u_camD - H) / (u_camD - zRef));
  vec3 B = E + dir * (u_camD / (u_camD - zRef));
  float texel = 2.0 * u_zoom * HEIGHT_MARGIN * max(u_tHeightTexel.x, u_tHeightTexel.y);
  float lean = length(B.xy - A.xy) / texel;     // height texels the ray crosses going down
  // Steps by the ray's lean: few where it looks straight down or all is low.
  int n = int(clamp(ceil(lean / 3.0), 1.0, 16.0));
  // Interleaved-gradient jitter of the first step trades banding for fine grain the paper hides.
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t0 = 0.0;
  float t1 = 1.0;
  for (int i = 1; i <= 16; i++) {
    if (i > n) break;
    float t = min(1.0, (float(i) - jit + 0.5) / float(n));
    vec3 P = mix(A, B, t);
    if (heightAt(P.xy) >= P.z) { t1 = t; break; }
    t0 = t;
  }
  for (int i = 0; i < 5; i++) {
    float t = 0.5 * (t0 + t1);
    vec3 P = mix(A, B, t);
    if (heightAt(P.xy) >= P.z) t1 = t; else t0 = t;
  }
  vec3 P = mix(A, B, t1);

  // Nearer the camera the plane is magnified: S shrinks with the height.
  mat2 S = R * (u_zoom / hs) * ((u_camD - P.z) / (u_camD - zRef));
  TessPlate pl;
  float detail;
  vec4 c = tessShadeRelief(P.xy, S, pl, detail);
  // The fine carving's slope from its screen derivatives (gouges cut, features raised).
  vec2 gd = inverse(transpose(S)) * vec2(dFdx(detail), dFdy(detail));
  vec3 N = normalize(vec3(-(pl.grad + gd), 1.0));
  // Where the ray met the side of a taller neighbour the wall's normal comes from the field.
  float wall = smoothstep(0.004, 0.014, P.z - pl.h);
  if (wall > 0.0) {
    vec2 e = vec2(texel, 0.0);
    vec2 g = vec2(heightAt(P.xy + e.xy) - heightAt(P.xy - e.xy), heightAt(P.xy + e.yx) - heightAt(P.xy - e.yx));
    vec3 Nw = normalize(vec3(-g, 0.25 * length(g) + 1e-4));
    N = normalize(mix(N, Nw, wall));
#ifndef TESS_CINEMATIC
    c.rgb *= 1.0 - 0.45 * wall;                  // the block's cut side, in the shade of its top
#endif
  }

  vec3 L = vec3(R * u_light.xy, u_light.z);
  // Soft shadow: march towards the light until above the bound (no steps when it's all flat).
  float shadow = 1.0;
  float reach = max(H - P.z, 0.0) / L.z;
  int ns = int(clamp(ceil(reach * length(L.xy) / texel / 4.0), 0.0, 8.0));
#ifdef TESS_CINEMATIC
  ns = tessShadowSteps(ns);
#endif
  for (int i = 1; i <= 8; i++) {
    if (i > ns) break;
    float t = reach * ((float(i) - jit) / float(ns)) + texel;
    vec3 Q = P + L * t;
    float clear = Q.z - heightAt(Q.xy);
    shadow = min(shadow, clamp(0.5 + 6.0 * clear / t, 0.0, 1.0));
  }
  shadow = smoothstep(0.0, 1.0, shadow);
#ifdef TESS_CINEMATIC
  // Physically based print materials under the same light (look.glsl): satin ink, paper in the
  // cuts, end grain on the cut sides, horizon AO from the height map.
  vec3 V = normalize(E - P);
  g_aoP = P.xy;
  float ao = tessHorizonAO(P.z, pl.grad, AO_RADIUS, jit);
  float px = sqrt(abs(determinant(S)));
  o = vec4(tessLookShade(c.rgb, g_tessPaper, wall, tessEndGrain(P, px), N, vec3(0.0, 0.0, 1.0), V, L, shadow, ao, 0.36, 0.64, L.z), 1.0);
#else
  float diff = max(dot(N, L), 0.0) / L.z;        // a flat top in full light prints as it is
  float ao = 0.72 + 0.28 * smoothstep(0.0, zRef, P.z);
  float shade = 0.36 + 0.64 * min(diff * shadow, 1.6);
  vec3 V = normalize(E - P);
  float sheen = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * shadow * 0.08;
  o = vec4(c.rgb * shade * ao + sheen, 1.0);
#endif
#else
  o = tessShade(u_O + R * s * u_zoom, R * (u_zoom / hs));
#endif
}
