#version 300 es
// Tile Horizon, floor surface: the tiling is an endless plane (z = 0) seen from a camera gliding
// low over it. Each pixel's ray meets the plane at p; S = dp/dpixel comes from the derivatives,
// so ink stays a constant weight in pixels however far the plane recedes. Towards the horizon
// the floor fades into the paper, by distance (fog) and by footprint (before a tile is too few
// pixels along its most foreshortened side to print without aliasing).
//
// With relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the
// height pass) the floor is the carved block and its tiles rise off it. The height pass writes
// the block's height into a map in the camera's own perspective: the screen's columns, and the
// rows u_hFrame from the lowest footprint a lifted tile can stand on to the end of the relief
// (lib/tess-floor.js heightFrame). Each pixel then marches its ray down through it, from the
// height bound to the ground (or the end of the relief), in steps of at most a tenth of a tile or
// two map texels (marchSteps), refined by bisection, and lights the block where it lands with a
// low raking light: the carving's normal, a soft shadow marched towards the light, the grooves
// darker. The relief fades out with distance (FADE_NEAR … FADE_FAR camera heights), well before
// the horizon, so the far floor is the flat block print.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec3 u_cam;     // camera ground position (xy, plane units) and height
uniform float u_ringR;  // ground distance of ring 1

// Rings by distance from the camera: figure/ground fronts sweep outwards across the floor.
float floorRing(vec2 c) { return clamp(length(c - u_cam.xy) / u_ringR, 0.0, 1.0); }
#define TESS_RING(c) floorRing(c)

#ifdef TESS_RELIEF
// Cards turn over about axes across the radial from the camera: they tip away as the front passes.
vec2 floorFlipDir(vec2 c) {
  vec2 d = c - u_cam.xy;
  float l = length(d);
  return l > 1e-4 ? d / l : vec2(1.0, 0.0);
}
#define TESS_FLIP_DIR(c) floorFlipDir(c)
#endif

// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec3 u_fwd;     // view basis (world): forward, right, up
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_focal;  // focal length, half-short-side units
uniform float u_fog;    // ground distance where the floor is paper

#ifdef TESS_RELIEF
// Mirrors of lib/tess-floor.js (tested there) and lib/tess-gl.js HEIGHT_SCALE.
#define STEP_GROUND 0.08
#define STEP_TEXELS 3.0
#define MARCH_MAX 32
#define HEIGHT_SCALE 0.35
uniform sampler2D u_tHeight;  // height / u_rel.y over the map's frame
uniform vec2 u_tHeightTexel;  // 1 / its size
uniform vec2 u_hFrame;        // the map's rows: screen y lo … hi (half-short-side units)
uniform vec2 u_rel;           // height scale (reliefScale), march top (marchTop, plane units)
uniform vec2 u_fadeR;         // the relief fades out between these ground distances
uniform float u_hsPrint;      // half the print target's short side (px)
uniform vec3 u_light;         // towards the light (world)

// The ray through screen point s (half-short-side units).
vec3 floorRay(vec2 s) { return u_fwd * u_focal + u_right * s.x + u_up * s.y; }

// dp/dpixel (print px) where the ray d meets the plane at height z: the analytic Jacobian of
// the ray–plane hit (the right vector is level, so only the up vector tips the hit's distance).
mat2 floorS(vec3 d, float z) {
  float down = -d.z;
  float k = (u_cam.z - z) / down;
  return mat2(k * u_right.xy, k * (u_up.xy + d.xy * (u_up.z / down))) / u_hsPrint;
}

// Height scale × the fade by distance (lib/tess-floor.js reliefScale, reliefFade).
float floorK(vec2 p) { return u_rel.x * (1.0 - smoothstep(u_fadeR.x, u_fadeR.y, length(p - u_cam.xy))); }

#ifndef TESS_HEIGHT_PASS
#define WALL_EPS 0.004
#define WALL_TEXELS 4.0
#define WALL_STEPS 6
// The exact height (plane units) at a ground point, as the height pass writes it.
float floorH(vec2 p, mat2 S) { return tessRelief(p, S).x * floorK(p); }

// The map's uv of the ground under a point: its footprint, seen from the camera.
vec2 floorUV(vec3 P) {
  vec3 v = vec3(P.xy - u_cam.xy, -u_cam.z);
  float cz = max(dot(v, u_fwd), 1e-6);
  vec2 sc = u_focal * vec2(dot(v, u_right), dot(v, u_up)) / cz;
  float hs = 0.5 * min(u_res.x, u_res.y);
  return vec2(0.5 + sc.x * hs / u_res.x, (sc.y - u_hFrame.x) / (u_hFrame.y - u_hFrame.x));
}

// Height (plane units) at a ground point, from the height pass; outside the map there's none.
float heightAt(vec2 p) {
  vec2 uv = floorUV(vec3(p, 0.0));
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return texture(u_tHeight, uv).r * u_rel.y;
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
#if defined(TESS_HEIGHT_PASS)
  // The map's texel → its screen point (rows stretched over u_hFrame) → the ground under it.
  s.y = mix(u_hFrame.x, u_hFrame.y, gl_FragCoord.y / u_res.y);
  vec3 d = floorRay(s);
  float down = -d.z;
  float h = 0.0;
  if (down > 0.0) {
    vec2 p = u_cam.xy + (u_cam.z / down) * d.xy;
    float k = floorK(p);
    if (k > 0.0) h = tessRelief(p, floorS(d, 0.0)).x * k;
  }
  o = vec4(h / max(u_rel.y, 1e-6), 0.0, 0.0, 1.0);
#elif defined(TESS_RELIEF)
  vec3 d = floorRay(s);
  float down = -d.z;
  if (down <= 0.0) {
#ifdef TESS_CINEMATIC
    o = vec4(tessAtmos(u_tPaper, 1.0, 1.0), tessCoC(1e6));
#else
    o = vec4(u_tPaper, 1.0);
#endif
    return;
  }
  vec3 E = u_cam;
  float lenXY = length(d.xy);
  float top = u_rel.y;
  float tB = E.z / down;                               // the ground
  float tA = (E.z - top) / down;                       // the bound
  float tEnd = min(tB, u_fadeR.y / max(lenXY, 1e-6));  // the end of the relief
  float t1 = tB;
  // Interleaved-gradient jitter of the first step trades banding for fine grain the paper hides.
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (tA < tEnd) {
    float ground = (tEnd - tA) * lenXY;
    vec2 lean = (floorUV(E + d * tA) - floorUV(E + d * tEnd)) / u_tHeightTexel;
    int n = int(clamp(ceil(min(ground / STEP_GROUND, length(lean) / STEP_TEXELS)), 1.0, float(MARCH_MAX)));
    float t0 = tA;
    bool hit = false;
    for (int i = 1; i <= MARCH_MAX; i++) {
      if (i > n) break;
      float t = mix(tA, tEnd, min(1.0, (float(i) - jit + 0.5) / float(n)));
      vec3 P = E + d * t;
      if (heightAt(P.xy) >= P.z) { t1 = t; hit = true; break; }
      t0 = t;
    }
    if (hit) {
      for (int i = 0; i < 5; i++) {
        float t = 0.5 * (t0 + t1);
        vec3 P = E + d * t;
        if (heightAt(P.xy) >= P.z) t1 = t; else t0 = t;
      }
      // The map smooths a tile's cut side into a ramp a texel wide, which a raking view turns
      // into a sawtooth along every lifted edge. Where the hit is off the exact block, march the
      // exact height a few texels either side of it and bisect: the side stands at the tile's
      // outline. Only those pixels pay for it.
      vec3 P = E + d * t1;
      mat2 S = floorS(d, P.z);
      float fp = max(length(S[0]), length(S[1]));
      if (abs(floorH(P.xy, S) - P.z) > WALL_EPS) {
        float dt = WALL_TEXELS * fp / HEIGHT_SCALE / max(lenXY, 1e-6);
        float lo = max(tA, t1 - dt);
        float hi = min(tB, t1 + dt);
        float a0 = lo;
        for (int i = 1; i <= WALL_STEPS; i++) {
          float t = mix(lo, hi, float(i) / float(WALL_STEPS));
          vec3 Q = E + d * t;
          if (floorH(Q.xy, S) >= Q.z) {
            float b0 = t;
            for (int j = 0; j < 6; j++) {
              float m = 0.5 * (a0 + b0);
              vec3 R = E + d * m;
              if (floorH(R.xy, S) >= R.z) b0 = m; else a0 = m;
            }
            t1 = b0;
            break;
          }
          a0 = t;
        }
      }
    }
  }
  vec3 P = E + d * t1;

  mat2 S = floorS(d, P.z);
  float dist = length(P.xy - E.xy);
  float fp = max(length(S[0]), length(S[1]));          // plane units per px, worst axis
  float fogA = 1.0 - exp(-3.0 * (dist / u_fog) * (dist / u_fog));
  float footA = smoothstep(0.5 / 16.0, 0.5 / 5.0, fp);
  float a = max(fogA, footA);
  if (a > 0.995) {
#ifdef TESS_CINEMATIC
    o = vec4(tessAtmos(u_tPaper, 1.0, a), tessCoC(t1 * u_focal));
#else
    o = vec4(u_tPaper, 1.0);
#endif
    return;
  }
  float k = floorK(P.xy);
  float fade = k / max(u_rel.x, 1e-6);
  TessPlate pl;
  float detail;
  vec4 c = tessShadeRelief(P.xy, S, pl, detail);
  pl.h *= k;
  pl.grad *= k;
  detail *= k;
  // The fine carving's slope from its screen derivatives (gouges cut, features raised).
  vec2 gd = inverse(transpose(S)) * vec2(dFdx(detail), dFdy(detail));
  vec3 N = normalize(vec3(-(pl.grad + gd), 1.0));
  // Where the ray met the side of a taller neighbour the wall's normal comes from the map.
  float texel = fp / HEIGHT_SCALE;                     // plane units per map texel, about
  // (Above the block where the map's ramp still holds the hit, or on the side under its top.)
  float wall = smoothstep(WALL_EPS, 0.014, abs(P.z - pl.h));
  if (wall > 0.0) {
    float e = 1.0 / HEIGHT_SCALE;                      // print px per map texel
    vec2 g = vec2(heightAt(P.xy + S[0] * e) - heightAt(P.xy - S[0] * e),
                  heightAt(P.xy + S[1] * e) - heightAt(P.xy - S[1] * e)) / (2.0 * e);
    g = inverse(transpose(S)) * g;
    vec3 Nw = normalize(vec3(-g, 0.25 * length(g) + 1e-4));
    // On the side under a tile's top (found exactly) it faces out across the tile's outline.
    if (pl.h > P.z && dot(pl.grad, pl.grad) > 1e-8) Nw = normalize(vec3(-normalize(pl.grad), 0.15));
    N = normalize(mix(N, Nw, wall));
    // The block's cut side: bare wood (the print's mean colour, no marks: the outline of the tile
    // in front would smear up it) in the shade of its top.
#ifndef TESS_CINEMATIC
    c.rgb = mix(c.rgb, u_tAvg, wall) * (1.0 - 0.45 * wall);
#endif
  }

  vec3 L = u_light;
  // Soft shadow: march towards the light until above the bound (no steps when it's all flat).
  float shadow = 1.0;
  float reach = max(top - P.z, 0.0) / L.z;
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
  // Physically based print materials under the same light (look.glsl), horizon AO from the map,
  // paper-coloured atmosphere towards the horizon, and the circle of confusion in alpha.
  vec3 V = normalize(E - P);
  g_aoP = P.xy;
  float ao = mix(1.0, tessHorizonAO(P.z, pl.grad, AO_RADIUS, jit), fade);
  vec3 lit = tessLookShade(c.rgb, g_tessPaper, wall, tessEndGrain(P, fp), N, vec3(0.0, 0.0, 1.0), V, L, shadow, ao, 0.36, 0.64, L.z);
  o = vec4(tessAtmos(lit, a, a), tessCoC(t1 * u_focal));
#else
  float diff = max(dot(N, L), 0.0) / L.z;              // a flat top in full light prints as it is
  float zRef = u_tRelief.x * RELIEF_BLOCK * k;         // resting tops
  float ao = 1.0 - 0.28 * fade * (1.0 - clamp(P.z / max(zRef, 1e-6), 0.0, 1.0));
  float shade = 0.36 + 0.64 * min(diff * shadow, 1.6);
  vec3 V = normalize(E - P);
  float sheen = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * shadow * 0.08;
  o = vec4(mix(c.rgb * shade * ao + sheen, u_tPaper, a), 1.0);
#endif
#else
  vec3 d = u_fwd * u_focal + u_right * s.x + u_up * s.y;
  float down = -d.z;
  // Computed for every pixel (sky too) so the derivatives stay defined across the horizon.
  float t = u_cam.z / max(down, 1e-4);
  vec2 p = u_cam.xy + t * d.xy;
  mat2 S = mat2(dFdx(p), dFdy(p));
  float dist = t * length(d.xy);
  float fp = max(length(S[0]), length(S[1]));       // plane units per px, worst axis
  float fogA = 1.0 - exp(-3.0 * (dist / u_fog) * (dist / u_fog));
  float footA = smoothstep(0.5 / 16.0, 0.5 / 5.0, fp); // half-unit tile under 16 → 5 px
  float a = down <= 0.0 ? 1.0 : max(fogA, footA);
  if (a > 0.995) {
#ifdef TESS_CINEMATIC
    o = vec4(tessAtmos(u_tPaper, 1.0, a), tessCoC(down > 0.0 ? t * u_focal : 1e6));
#else
    o = vec4(u_tPaper, 1.0);
#endif
    return;
  }
  vec4 c = tessShade(p, S);
#ifdef TESS_CINEMATIC
  o = vec4(tessAtmos(c.rgb, a, a), tessCoC(t * u_focal));
#else
  o = vec4(mix(c.rgb, u_tPaper, a), 1.0);
#endif
#endif
}
