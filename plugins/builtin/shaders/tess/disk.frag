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

// #include disk

#ifdef TESS_RELIEF
// Relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the height
// pass): the print is the carved block seen from a camera u_camD above the disk's centre, under
// a raking light, as Metamorphosis's (shaders/tess/metamorphosis.frag): the height pass writes
// the face's height over the disk's square, each pixel marches its ray down through it, prints
// the kite where it lands and lights it, with a soft shadow marched towards the light. The music
// is the engine's: beat waves and the spectrum's heave by ring (hyperbolic distance from the
// centre), onset pops, each kite ± LIFT_VARY.
uniform vec3 u_light;         // towards the light (x right, y up, z out of the face)
uniform float u_camD;         // camera height above the face plane (disk units)

float diskKiteLift() {
  float ring = diskRing(vec2(g_dk.centreD, 0.0));
  float id = float(g_dk.id);
  float vary = 1.0 - LIFT_VARY + 2.0 * LIFT_VARY * tessHash12(vec2(id * 0.731 + 3.7, 1.3));
  return u_tRelief.x * (tessLiftAt(ring) * vary + tessPopAt(vec2(id, 0.37), ring));
}
#endif
#if defined(TESS_CINEMATIC) && defined(TESS_RELIEF) && !defined(TESS_HEIGHT_PASS)
// The cinematic Look's horizon AO reads the face's height map (disk units) round g_aoW.
vec2 g_aoW;
#define TESS_AO_HEIGHT(o) diskHeightAt(g_aoW + (o))
#define AO_RADIUS 0.03
#endif
// #include look

#if defined(TESS_HEIGHT_PASS)
void main() {
  // The height map covers the disk's square, [−1, 1]² over the target.
  vec2 w = 2.0 * gl_FragCoord.xy / u_res - 1.0;
  float texel = 2.0 / min(u_res.x, u_res.y);
  float h = 0.0;
  float rr = dot(w, w);
  if (rr < 1.0 && 0.5 * u_kiteA * (1.0 - rr) / texel > 0.5 * KITE_FADE_LO) h = diskRelief(w, 1.0, mat2(1.0), texel).h;
  o = vec4((clamp(h, u_kH.x, u_kH.x + u_kH.y) - u_kH.x) / u_kH.y, 0.0, 0.0, 1.0);
}
#elif defined(TESS_RELIEF)
void main() {
  float R = u_disk.z;
  float fpx = 1.0 / u_tPxScale;
  float H = u_kH.x + u_kH.y;
  float Lo = u_kH.x;
  // The ray from the camera through the pixel's point of the face plane: A at the top of the
  // relief, B at its floor.
  vec2 w0 = (gl_FragCoord.xy - u_disk.xy) / R;
  vec3 E = vec3(0.0, 0.0, u_camD);
  vec3 dir = vec3(w0, 0.0) - E;
  vec3 A = E + dir * ((u_camD - H) / u_camD);
  vec3 B = E + dir * ((u_camD - Lo) / u_camD);
  float texel = 2.0 * max(u_tHeightTexel.x, u_tHeightTexel.y);
  float lean = length(B.xy - A.xy) / texel;
  int n = int(clamp(ceil(lean / 3.0), 1.0, 16.0));
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t0 = 0.0;
  float t1 = 1.0;
  for (int i = 1; i <= 16; i++) {
    if (i > n) break;
    float t = min(1.0, (float(i) - jit + 0.5) / float(n));
    vec3 P = mix(A, B, t);
    if (diskHeightAt(P.xy) >= P.z) { t1 = t; break; }
    t0 = t;
  }
  for (int i = 0; i < 5; i++) {
    float t = 0.5 * (t0 + t1);
    vec3 P = mix(A, B, t);
    if (diskHeightAt(P.xy) >= P.z) t1 = t; else t0 = t;
  }
  vec3 P = mix(A, B, t1);
  vec2 w = P.xy;
  float rw = length(w);
  // Nearer the camera the face is magnified.
  float sc = (u_camD - P.z) / u_camD;
  float tileSize = rw < 1.0 ? 0.5 * u_kiteA * R * (1.0 - rw * rw) / sc : 0.0;
  vec3 col = u_tInk;
  vec2 grad = vec2(0.0);
  float ao = 1.0;
  float wall = 0.0;
#ifdef TESS_CINEMATIC
  vec3 wood = vec3(0.0);
  float paperW = 0.0;
#endif
  if (tileSize > 0.6 * fpx) {
    mat2 Jpx = mat2(sc);
    DiskRelief r = diskRelief(w, R, Jpx, texel);
    vec4 c;
    vec2 marks = vec2(0.0);
    if (r.pit > 0.5) c = vec4(mix(u_tInk, u_tPaper, 0.22), 1.0);
    else {
      int fc = TESS_CLASS(r.k.t.cls, r.k.t.centre);
      vec3 fill = r.face > 0.5 ? u_tClsNext[fc] : u_tCls[fc];
      c = tessPrintFill(r.k.t, fill, r.face, r.k.pxq, tileSize, r.k.dpx, 0.0, 0.5 * r.k.t.uv, marks);
    }
    float shown = smoothstep(0.6 * fpx, 1.6 * fpx, tileSize);
    col = mix(u_tInk, c.rgb, shown);
    grad = (r.grad + diskDetail(r, marks, R, Jpx, tileSize, fpx)) * shown;
    ao = mix(1.0, 0.72 + 0.28 * r.prof, r.kPx * min(1.0, u_tRelief.x / 0.25));
    // Where the ray met the side of a taller neighbour: the block's cut side, in the shade of its top.
    wall = smoothstep(0.004, 0.014, (P.z - r.h) / max(r.scale, 1e-5)) * r.kPx;
#ifdef TESS_CINEMATIC
    // Cinematic (look.glsl): bare end grain on the cut sides, horizon AO from the height map.
    wood = tessWood(wall, vec3(w, P.z) / max(r.scale, 1e-5), sc / (R * max(r.scale, 1e-5)));
    g_aoW = w;
    ao = mix(1.0, tessHorizonAO(P.z, r.grad, AO_RADIUS, jit), r.kPx * min(1.0, u_tRelief.x / 0.25));
    paperW = g_tessPaper * shown;
#else
    col *= 1.0 - 0.45 * wall;
#endif
  }
  vec3 N = normalize(vec3(-grad, 1.0));
  if (wall > 0.0) {
    vec2 e = vec2(texel, 0.0);
    vec2 g = vec2(diskHeightAt(w + e.xy) - diskHeightAt(w - e.xy), diskHeightAt(w + e.yx) - diskHeightAt(w - e.yx));
    N = normalize(mix(N, normalize(vec3(-g, 0.25 * length(g) + 1e-6)), wall));
  }
  vec3 L = u_light;
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
    float clear = Q.z - diskHeightAt(Q.xy);
    shadow = min(shadow, clamp(0.5 + 6.0 * clear / t, 0.0, 1.0));
  }
  shadow = smoothstep(0.0, 1.0, shadow);
#ifdef TESS_CINEMATIC
  // Physically based print materials (look.glsl): satin ink, paper in the cuts, end grain.
  col = tessLookShade(col, paperW, wall, wood, N, vec3(0.0, 0.0, 1.0), normalize(E - P), L, shadow, ao, 0.36, 0.64, L.z);
#else
  float diff = max(dot(N, L), 0.0) / L.z;          // a flat top in full light prints as it is
  float shade = 0.36 + 0.64 * min(diff * shadow, 1.6);
  vec3 V = normalize(E - P);
  float sheen = pow(max(dot(reflect(-L, N), V), 0.0), 24.0) * shadow * 0.08;
  col = col * shade * ao + sheen;
#endif
  col = mix(u_tPaper, col, clamp((1.0 - rw) * R + 0.5, 0.0, 1.0));
  o = vec4(col, 1.0);
}
#else
void main() {
  vec2 w = (gl_FragCoord.xy - u_disk.xy) / u_disk.z;
  float rw = length(w);
  float fpx = 1.0 / u_tPxScale;
  // A kite's size in target px from the disk's metric (2|dw| / (1 − |w|²)): one size per tile
  // for the print's fades, smooth across the kite.
  float tileSize = rw < 1.0 ? 0.5 * u_kiteA * u_disk.z * (1.0 - rw * rw) : 0.0;
  vec3 col = u_tInk;
  // Tiles below about a pixel print as ink (the crowded rim); don't fold for them.
  if (tileSize > 0.6 * fpx) col = mix(u_tInk, diskShade(w, u_disk.z, mat2(1.0), tileSize).rgb, smoothstep(0.6 * fpx, 1.6 * fpx, tileSize));
  // The disk's edge, antialiased, onto the paper.
  col = mix(u_tPaper, col, clamp((1.0 - rw) * u_disk.z + 0.5, 0.0, 1.0));
  o = vec4(col, 1.0);
}
#endif
