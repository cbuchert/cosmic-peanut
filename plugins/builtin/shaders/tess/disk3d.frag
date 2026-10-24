#version 300 es
// Poincaré Disk, sphere scene: the print as a physical object. A thin coin floats at the centre
// of a large sphere; its face carries the hyperbolic tiling (disk.glsl, both faces), its rim is
// the live waveform, and the sphere's inner wall carries the cube-sphere tiling (sphere.glsl),
// turning the other way. src/lib/disk3d.js holds the motion (tested), src/poincare-disk.js the
// wiring.
//
// Per pixel, at most one full tessellation — the coin's face or the sphere wall — plus, on the
// face, one cheap look-up of the wall in the reflection (one warp step, no print). Every screen
// derivative is taken before the branches: the face chart (an analytic ray–plane hit) and the
// wall's hit direction are computed for every pixel; the coin itself is ray-marched only inside
// its bounding sphere (its signed distance, with the waveform rim, is not exact: steps × 0.75).
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;
out vec4 o;

int g_surf;                   // 0: the coin's face, 1: the sphere wall

// #include sphere

// Ring hook: the face's rings are hyperbolic distance from its centre (tile centres carried as
// pseudo-distance, as on the flat print); the wall's are angle from its pole.
uniform float u_ringR;
float diskRing(vec2 c) { return clamp(2.0 * atanh(min(c.x, 0.9999999)) / u_ringR, 0.0, 1.0); }
#define TESS_RING(c) (g_surf == 1 ? sphRing(c) : diskRing(c))
#define TESS_CLASS(cls, c) (g_surf == 1 ? sphClass(cls, c) : (cls))

// #include tess

#define DISK_IMPACT
// #include disk


uniform vec2 u_res;           // target size (px)
uniform vec3 u_eye;           // camera (world; the coin at the origin)
uniform mat3 u_cam;           // camera basis: right, up, forward
uniform float u_tanHalf;      // tan(vertical fov / 2)
uniform mat3 u_coin;          // world → coin (y along its axis, spun)
uniform float u_rim[128];     // the waveform round the rim (times its amplitude)
uniform vec4 u_coinG;         // face radius, rim radius (face + bevel), half-thickness, bound
uniform mat3 u_wall;          // world → sphere frame (the counter-spin)
uniform float u_SR;           // sphere radius
uniform vec3 u_light;         // key light (world, unit)
uniform vec2 u_kick;          // seconds since the beat, beat length
uniform vec2 u_lift;          // ripple and spectrum-heave heights (world units)
uniform vec2 u_Iw;            // the impact on the face now (disk units)
uniform vec2 u_treble;        // shimmer strength, time
uniform float u_fog;

#if defined(TESS_CINEMATIC) && defined(TESS_RELIEF) && !defined(TESS_HEIGHT_PASS)
// The cinematic Look's horizon AO reads the face's height map (world units) round g_aoW (disk
// units); offsets are world units on the face.
vec2 g_aoW;
#define TESS_AO_HEIGHT(o) diskHeightAt(g_aoW + (o) / u_coinG.x)
#define AO_RADIUS 0.06
#endif
// #include look

const float PI = 3.14159265;

// ---- The coin ------------------------------------------------------------------------------------

float rimAt(float th) {
  float f = (th / (2.0 * PI) + 0.5) * 128.0;
  float i = floor(f);
  int a = int(mod(i, 128.0));
  int b = int(mod(i + 1.0, 128.0));
  return mix(u_rim[a], u_rim[b], f - i);
}

// Rounded flat cylinder: flat faces at |y| = half out to the rim, a round edge whose radius
// follows the waveform.
float coinSdf(vec3 p) {
  float r = length(p.xz);
  float re = u_coinG.y + rimAt(atan(p.z, p.x));
  float rb = u_coinG.z;
  vec2 q = vec2(r - (re - rb), abs(p.y));
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rb;
}

vec3 coinNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0) * 0.0015;
  return normalize(k.xyy * coinSdf(p + k.xyy) + k.yyx * coinSdf(p + k.yyx) +
                   k.yxy * coinSdf(p + k.yxy) + k.xxx * coinSdf(p + k.xxx));
}

// ---- The music's lift (src/lib/disk3d.js rippleLift, specLift) ----------------------------------

float rippleLift(float age, float d, float period) {
  float a = age - d / 3.0;
  if (a <= 0.0) return 0.0;
  float fall = max(0.05, 0.9 * period - 0.08);
  float env = a < 0.08 ? smoothstep(0.0, 1.0, a / 0.08) : 1.0 - smoothstep(0.0, 1.0, (a - 0.08) / fall);
  return env * exp(-d / 1.1);
}

float specLift(float d) {
  float x = clamp(d / u_ringR, 0.0, 1.0) * 15.0;
  int i = min(14, int(floor(x)));
  return mix(u_tBands[i], u_tBands[i + 1], x - float(i));
}

float hdist(float pd) { return 2.0 * atanh(min(pd, 0.9999999)); }

// The face's height at disk point w (world units): the impact ripple and the spectrum heave,
// eased to nothing at the face's edge so it stays joined to the rim.
float faceHeight(vec2 w) {
  float r = length(w);
  if (r >= 1.0) return 0.0;
  float h = u_lift.x * rippleLift(u_kick.x, hdist(pdist(w, u_Iw)), u_kick.y) + u_lift.y * specLift(hdist(r));
  return h * (1.0 - smoothstep(0.82, 0.98, r));
}

#ifdef TESS_RELIEF
// ---- Relief: the face carved like a woodblock (disk.glsl diskRelief) ---------------------------
// The beat's ripple and the spectrum's heave lift whole kites now (u_kLift; the smooth swell
// above keeps the share u_kLift.z, all of it at Relief 0): the ripple by each kite's hyperbolic
// distance from the impact, the heave ring by ring from the centre, ± LIFT_VARY per kite; onsets
// pop single kites near the ripple's front (u_kPop). lib/disk-relief.js kiteLift mirrors it.
#define POP_RING_BAND 0.35
#define REFINE_STEP 0.006     // a height-map step (world units per texel) worth refining…
#define REFINE_STEPS 6        // …in this many exact steps over ± 2 texels of the ray
uniform vec4 u_kLift;         // beat, heave (tile units), smooth swell's share, the previous ripple's age (s)
uniform vec4 u_kPop[3];       // per pop: height (tile units), ring (hyperbolic, from the impact), seed, 0

#define KITE_REACH 2.2
// rippleLift with the kites' wider reach (lib/disk-relief.js KITE_REACH).
float kiteRipple(float age, float d, float period) {
  float a = age - d / 3.0;
  if (a <= 0.0) return 0.0;
  float fall = max(0.05, 0.9 * period - 0.08);
  float env = a < 0.08 ? smoothstep(0.0, 1.0, a / 0.08) : 1.0 - smoothstep(0.0, 1.0, (a - 0.08) / fall);
  return env * exp(-d / KITE_REACH);
}

float diskKiteLift() {
  float id = float(g_dk.id);
  float vary = 1.0 - LIFT_VARY + 2.0 * LIFT_VARY * tessHash12(vec2(id * 0.731 + 3.7, 1.3));
  float dI = hdist(g_dk.impactD);
  float ripple = kiteRipple(u_kick.x, dI, u_kick.y) + kiteRipple(u_kLift.w, hdist(g_dk.prevD), u_kick.y);
  float h = u_kLift.x * ripple * vary + u_kLift.y * specLift(hdist(g_dk.centreD));
  for (int k = 0; k < 3; k++) {
    vec4 pp = u_kPop[k];
    if (pp.x > 0.0 && abs(dI - pp.y) < POP_RING_BAND && tessHash12(vec2(id * 1.7 + pp.z, 0.5)) < POP_DENSITY) h += pp.x;
  }
  return h;
}

// The face's height at w (world units): the carved kites plus the smooth swell's share.
float faceRelief(vec2 w, float texel) {
  float rr = dot(w, w);
  float h = 0.0;
  if (rr < 1.0 && 0.5 * u_kiteA * (1.0 - rr) / texel > 0.5 * KITE_FADE_LO) h = diskRelief(w, 1.0, mat2(1.0), texel).h;
  if (u_kLift.z > 0.0) h += u_kLift.z * faceHeight(w);
  return clamp(h, u_kH.x, u_kH.x + u_kH.y);
}
#endif

// ---- Ambient occlusion -------------------------------------------------------------------------

// The carved outline as a V groove: depth GROOVE_D of its half-width gw at the outline, nothing
// beyond gw (world units, d the distance to the outline).
const float GROOVE_W = 0.045;  // the groove's half-width, tile units (tiles are 0.5 across)
const float GROOVE_D = 0.6;
float groove(float d, float gw) { return GROOVE_D * gw * (1.0 - smoothstep(0.0, gw, d)); }

// Face AO by a horizon test on a few samples of the surface around the point: the groove's walls
// either side at 0.5, 1 and 2 groove half-widths, and the music's relief (the ripple and the heave,
// faceHeight) in four directions at 0.04 and 0.1 world units. Lifted neighbours and groove walls
// rising above the point darken it, in proportion to how steeply they rise.
float faceAO(vec2 w, float h0, float dw, float gw) {
  float occ = 0.0;
  float g0 = groove(dw, gw);
  for (int i = 0; i < 3; i++) {
    float r = gw * (i == 0 ? 0.5 : i == 1 ? 1.0 : 2.0);
    float up = max(0.0, g0 - groove(dw + r, gw)) + max(0.0, g0 - groove(abs(dw - r), gw));
    occ += up / r * (i == 2 ? 0.35 : 0.6);
  }
  for (int i = 0; i < 2; i++) {
    float r = i == 0 ? 0.04 : 0.1;
    float o = r / u_coinG.x;
    float rise = max(0.0, faceHeight(w + vec2(o, 0.0)) - h0) + max(0.0, faceHeight(w - vec2(o, 0.0)) - h0) +
                 max(0.0, faceHeight(w + vec2(0.0, o)) - h0) + max(0.0, faceHeight(w - vec2(0.0, o)) - h0);
    occ += rise / r * 0.5;
  }
  return clamp(1.0 - 0.55 * occ, 0.35, 1.0);
}

// Rim AO: the classic three samples of the coin's distance field out along the normal; the
// hollows between the waveform's bumps darken.
float rimAO(vec3 p, vec3 n) {
  float occ = 0.0;
  for (int i = 1; i <= 3; i++) {
    float h = 0.025 * float(i);
    occ += (h - coinSdf(p + n * h)) / h / float(i);
  }
  return clamp(1.0 - 0.6 * occ, 0.4, 1.0);
}

// ---- The sphere wall ---------------------------------------------------------------------------

int faceOfDir(vec3 h) {
  vec3 ah = abs(h);
  return ah.x >= ah.y && ah.x >= ah.z ? (h.x >= 0.0 ? 0 : 1) : ah.y >= ah.z ? (h.y >= 0.0 ? 2 : 3) : (h.z >= 0.0 ? 4 : 5);
}

vec2 faceChart(vec3 h, int f) {
  mat3 F = u_frame[f];
  float w = dot(h, F[0]);
  return 0.5 * u_N * (1.0 + atan(vec2(dot(h, F[1]), dot(h, F[2])) / w) / 0.785398163);
}

float wallT(vec3 p, vec3 d) {
  float b = dot(p, d);
  float c = dot(p, p) - u_SR * u_SR;
  return -b + sqrt(max(b * b - c, 0.0));
}

// The wall seen in the lacquer: one warp step and the bare tile, its class colour, the outline
// as a soft dark line. Cheap and blurry, as a reflection in a clear coat is.
vec3 wallCheap(vec3 p, vec3 d) {
  vec3 h = normalize(u_wall * (p + wallT(p, d) * d));
  g_face = faceOfDir(h);
  vec2 q = faceChart(h, g_face);
  mat2 J;
  float m;
  q += tessField(q, J, m);
  Tile t = tessTile(q);
  vec3 f = u_tCls[sphClass(t.cls, t.centre)];
  return mix(u_tInk, f, smoothstep(0.0, 0.06, t.dist)) * 0.9;
}

float ggx(vec3 n, vec3 v, vec3 l, float a) {
  vec3 hv = normalize(l + v);
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 1e-3);
  float nh = max(dot(n, hv), 0.0);
  float a2 = a * a;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = 0.5 * a;
  float G = nv / (nv * (1.0 - k) + k) * nl / (nl * (1.0 - k) + k);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  return D * G * F / (4.0 * nv * max(nl, 1e-3) + 1e-4) * nl;
}

#if defined(TESS_RELIEF) && !defined(TESS_HEIGHT_PASS)
// The face under the key light, carved: the print on the kite the ray met (the march found w at
// height eta above the face plane, sc = how much nearer than the face plane, so magnified), the
// kite's and the fine carving's normals, a soft shadow marched towards the light through the height
// map, the grooves darker, the lacquer over it all.
vec3 shadeFace(vec2 w, float eta, float sc, mat2 Jpx, float side, vec3 pw, vec3 rd, float fpx, float jit) {
  g_surf = 0;
  vec3 V = -rd;
  float texel = 2.0 * max(u_tHeightTexel.x, u_tHeightTexel.y);
  mat2 Jp = Jpx * sc;
  float px = sqrt(abs(determinant(Jp)));
  float rw = length(w);
  float tileSize = rw < 1.0 ? 0.5 * u_kiteA * (1.0 - rw * rw) / max(px, 1e-6) : 0.0;
  vec3 base = u_tInk;
  vec2 grad = vec2(0.0);
  float ao = 1.0;
  float wall = 0.0;
  float paperW = 0.0;
  if (u_kLift.z > 0.0) {
    float e = 0.004;
    grad += u_kLift.z * vec2(faceHeight(w + vec2(e, 0.0)) - faceHeight(w - vec2(e, 0.0)),
                             faceHeight(w + vec2(0.0, e)) - faceHeight(w - vec2(0.0, e))) / (2.0 * e * u_coinG.x);
  }
  if (tileSize > 0.6 * fpx) {
    DiskRelief r = diskRelief(w, 1.0, Jp, texel);
    vec4 c;
    vec2 marks = vec2(0.0);
    if (r.pit > 0.5) c = vec4(mix(u_tInk, u_tPaper, 0.22), 1.0);
    else {
      int fc = TESS_CLASS(r.k.t.cls, r.k.t.centre);
      vec3 fill = r.face > 0.5 ? u_tClsNext[fc] : u_tCls[fc];
      c = tessPrintFill(r.k.t, fill, r.face, r.k.pxq, tileSize, r.k.dpx, 0.0, 0.5 * r.k.t.uv, marks);
    }
    float shown = smoothstep(0.6 * fpx, 1.6 * fpx, tileSize);
    base = mix(u_tInk, c.rgb, shown);
    grad += (r.grad + diskDetail(r, marks, 1.0, Jp, tileSize, fpx)) * shown;
    // Lifted kites: lighter tops (their shadows and cut sides do the rest).
    base *= 1.0 + 0.5 * clamp(r.lift / 0.2, 0.0, 1.5) * r.kPx;
    ao = mix(1.0, 0.72 + 0.28 * r.prof, r.kPx * min(1.0, u_tRelief.x / 0.25));
    float hk = r.h + u_kLift.z * faceHeight(w);
    wall = smoothstep(0.004, 0.014, (eta - hk) / max(r.scale, 1e-5)) * r.kPx;
#ifdef TESS_CINEMATIC
    // Cinematic (look.glsl): bare end grain on the cut sides, horizon AO from the height map.
    base = mix(base, tessEndGrain(vec3(w * u_coinG.x, eta) / max(r.scale, 1e-5), px * u_coinG.x / max(r.scale, 1e-5)), wall);
    g_aoW = w;
    ao = mix(1.0, tessHorizonAO(eta, grad, AO_RADIUS, jit), r.kPx * min(1.0, u_tRelief.x / 0.25));
    paperW = g_tessPaper * shown;
#else
    base *= 1.0 - 0.45 * wall;
#endif
    // Treble glints along the gouges.
    float x = g_dk.dist / 0.03;
    float idx = floor(x);
    float line = (1.0 - smoothstep(0.08, 0.3, abs(fract(x) - 0.5))) * step(0.5, idx) * step(idx, 6.0);
    line *= smoothstep(3.0, 6.0, 0.03 * g_dk.dpx / max(g_dk.dist, 1e-6));
    float glint = 0.5 + 0.5 * sin(u_treble.y * 23.0 + idx * 2.1 + g_dk.uv.x * 31.0 + g_dk.uv.y * 17.0);
    base += u_treble.x * line * glint * glint * 0.35 * (u_tPaper + 0.2);
  }
  // Normals in the face's frame (w.x, w.y, out of the face), then the coin's, then the world's.
  vec3 nf = normalize(vec3(-grad, 1.0));
  if (wall > 0.0) {
    vec2 e = vec2(texel, 0.0);
    vec2 g = vec2(diskHeightAt(w + e.xy) - diskHeightAt(w - e.xy), diskHeightAt(w + e.yx) - diskHeightAt(w - e.yx));
    nf = normalize(mix(nf, normalize(vec3(-g, 0.25 * length(g) + 1e-6)), wall));
  }
  vec3 N = normalize(transpose(u_coin) * vec3(nf.x, side * nf.z, -side * nf.y));
  vec3 N0 = normalize(transpose(u_coin) * vec3(0.0, side, 0.0));
  // The light in the face's frame, and a soft shadow towards it.
  vec3 ll = u_coin * u_light;
  vec3 Lf = vec3(ll.x, -side * ll.z, side * ll.y);
  float shadow = 1.0;
  if (Lf.z > 0.02) {
    float top = u_kH.x + u_kH.y;
    float reach = max(top - eta, 0.0) / Lf.z;
    int ns = int(clamp(ceil(reach * length(Lf.xy) / texel / 4.0), 0.0, 8.0));
#ifdef TESS_CINEMATIC
    ns = tessShadowSteps(ns);
#endif
    vec3 P = vec3(w, eta);
    for (int i = 1; i <= 8; i++) {
      if (i > ns) break;
      float t = reach * ((float(i) - jit) / float(ns)) + texel;
      vec3 Q = P + Lf * t;
      float clear = Q.z - diskHeightAt(Q.xy);
      shadow = min(shadow, clamp(0.5 + 6.0 * clear / t, 0.0, 1.0));
    }
    shadow = smoothstep(0.0, 1.0, shadow);
  }
  // The coin's light as before, times the carving's: a facet against a flat top in the same light.
  float nl0 = max(dot(N0, u_light), 0.0);
  float rel = max(dot(N, u_light), 0.0) * shadow / max(nl0, 0.25);
#ifdef TESS_CINEMATIC
  // Paper in the cuts takes the light round its fibres (Green's wrap, look.glsl).
  rel = mix(rel, tessWrap(dot(N, u_light), PAPER_WRAP) * shadow / tessWrap(max(nl0, 0.25), PAPER_WRAP), paperW);
#endif
  float carve = 0.4 + 0.6 * min(rel, 1.6);
  float nv = max(dot(N, V), 1e-3);
  float fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  vec3 refl = mix(wallCheap(pw, reflect(rd, N)), 0.9 * u_tAvg, smoothstep(0.02, 0.12, length(grad)));
  vec3 col = base * (0.66 + 0.34 * nl0) * carve * ao * (1.0 - 0.7 * fr) + 0.7 * fr * refl;
  col += ggx(N, V, u_light, 0.16) * vec3(1.0, 0.97, 0.9) * 0.8 * (0.35 + 0.65 * shadow);
  return col;
}
#endif

#ifdef TESS_HEIGHT_PASS
// The face's height over the disk's square ([−1, 1]² over the target), for the march.
void main() {
  g_surf = 0;
  vec2 w = 2.0 * gl_FragCoord.xy / u_res - 1.0;
  float h = faceRelief(w, 2.0 / min(u_res.x, u_res.y));
  o = vec4((h - u_kH.x) / u_kH.y, 0.0, 0.0, 1.0);
}
#else
void main() {
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * u_res.y);
  vec3 rd = normalize(u_cam * vec3(s * u_tanHalf, 1.0));
  float pix = 2.0 * u_tanHalf / u_res.y;               // radians per target px
  float fpx = 1.0 / u_tPxScale;

  // The wall's hit and its face chart, for every pixel (smooth screen derivatives).
  float tw = wallT(u_eye, rd);
  vec3 hw = u_eye + tw * rd;
  vec3 h = normalize(u_wall * hw);
  vec3 dhx = dFdx(h);
  vec3 dhy = dFdy(h);
  int wf = faceOfDir(h);
  mat3 F = u_frame[wf];
  float fw = dot(h, F[0]);
  float su = dot(h, F[1]);
  float sv = dot(h, F[2]);
  vec2 wp = 0.5 * u_N * (1.0 + atan(vec2(su, sv) / fw) / 0.785398163);
  float kk = 2.0 * u_N / PI;
  vec3 ju = kk / (fw * fw + su * su) * (fw * F[1] - su * F[0]);
  vec3 jv = kk / (fw * fw + sv * sv) * (fw * F[2] - sv * F[0]);
  mat2 S = mat2(dot(ju, dhx), dot(jv, dhx), dot(ju, dhy), dot(jv, dhy));

  // The face chart: the ray against the face plane on the camera's side, for every pixel.
  vec3 ro = u_coin * u_eye;
  vec3 rl = u_coin * rd;
  float side = ro.y >= 0.0 ? 1.0 : -1.0;
  float tp = abs(rl.y) > 1e-5 ? (side * u_coinG.z - ro.y) / rl.y : 1e6;
  vec3 pf = ro + min(max(tp, 0.0), 1e3) * rl;
  vec2 wface = vec2(pf.x, -side * pf.z) / u_coinG.x;
  mat2 Jpx = mat2(dFdx(wface), dFdy(wface));

  // The coin. Nothing on it rises above the face plane, so a face-plane hit inside the printed
  // disk is the hit; otherwise march (only the rim is left) inside the bounding sphere.
  bool hit = false;
  float th = 0.0;
  float closest = 1e9;                                  // least distance / ray length (silhouette)
  float bb = dot(ro, rl);
  float cc = dot(ro, ro) - u_coinG.w * u_coinG.w;
  float disc = bb * bb - cc;
#ifdef TESS_RELIEF
  // The carved face: march the ray down through the relief (the height map), from the top of
  // its range to its floor, where it crosses the face; a hit outside the face is the rim's.
  bool faceHit = false;
  vec2 wHit = vec2(0.0);
  float etaHit = 0.0;
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (side * rl.y < -1e-5) {
    float tA = max(0.0, (side * (u_coinG.z + u_kH.x + u_kH.y) - ro.y) / rl.y);
    float tB = (side * (u_coinG.z + u_kH.x) - ro.y) / rl.y;
    vec3 pA = ro + tA * rl;
    vec3 pB = ro + tB * rl;
    vec2 wA = vec2(pA.x, -side * pA.z) / u_coinG.x;
    vec2 wB = vec2(pB.x, -side * pB.z) / u_coinG.x;
    if (min(dot(wA, wA), dot(wB, wB)) < 1.0) {
      float texel = 2.0 * max(u_tHeightTexel.x, u_tHeightTexel.y);
      int n = int(clamp(ceil(length(wB - wA) / texel / 3.0), 1.0, 16.0));
      float t0 = 0.0;
      float t1 = 1.0;
      for (int i = 1; i <= 16; i++) {
        if (i > n) break;
        float t = min(1.0, (float(i) - jit + 0.5) / float(n));
        vec3 P = ro + mix(tA, tB, t) * rl;
        if (diskHeightAt(vec2(P.x, -side * P.z) / u_coinG.x) >= side * P.y - u_coinG.z) { t1 = t; break; }
        t0 = t;
      }
      for (int i = 0; i < 5; i++) {
        float t = 0.5 * (t0 + t1);
        vec3 P = ro + mix(tA, tB, t) * rl;
        if (diskHeightAt(vec2(P.x, -side * P.z) / u_coinG.x) >= side * P.y - u_coinG.z) t1 = t; else t0 = t;
      }
      float t = mix(tA, tB, t1);
      vec3 P = ro + t * rl;
      vec2 w = vec2(P.x, -side * P.z) / u_coinG.x;
      // At a lifted kite's cut side the height map's texels (many px in a close-up) leave a
      // sawtooth: there, find the hit again against the kites' exact height, from a little before
      // the map's hit to a little after (only pixels at such a step pay for the extra folds).
      vec2 e = vec2(texel, 0.0);
      float step = max(abs(diskHeightAt(w + e.xy) - diskHeightAt(w - e.xy)), abs(diskHeightAt(w + e.yx) - diskHeightAt(w - e.yx)));
      if (step > REFINE_STEP && dot(w, w) < 1.0) {
        float span = 2.0 * texel * u_coinG.x / max(length(vec2(rl.x, rl.z)), 1e-3);
        float r0 = t - span;
        float r1 = t + span;
        float lo = r0;
        float hi = r1;
        for (int i = 1; i <= REFINE_STEPS; i++) {
          float tt = mix(r0, r1, float(i) / float(REFINE_STEPS));
          vec3 Q = ro + tt * rl;
          if (faceRelief(vec2(Q.x, -side * Q.z) / u_coinG.x, texel) >= side * Q.y - u_coinG.z) { hi = tt; break; }
          lo = tt;
        }
        for (int i = 0; i < 3; i++) {
          float tt = 0.5 * (lo + hi);
          vec3 Q = ro + tt * rl;
          if (faceRelief(vec2(Q.x, -side * Q.z) / u_coinG.x, texel) >= side * Q.y - u_coinG.z) hi = tt; else lo = tt;
        }
        t = hi;
        P = ro + t * rl;
        w = vec2(P.x, -side * P.z) / u_coinG.x;
      }
      if (dot(w, w) < 1.0) {
        hit = true;
        faceHit = true;
        th = t;
        wHit = w;
        etaHit = side * P.y - u_coinG.z;
      }
    }
  }
  if (!hit && disc > 0.0) {
#else
  if (tp > 0.0 && tp < 1e5 && length(pf.xz) < u_coinG.x) {
    hit = true;
    th = tp;
  } else if (disc > 0.0) {
#endif
    float sq = sqrt(disc);
    float t = max(-bb - sq, 0.0);
    float t1 = -bb + sq;
    for (int i = 0; i < 48; i++) {
      float d = coinSdf(ro + t * rl);
      closest = min(closest, d / max(t, 1e-3));
      if (d < 0.0004 * (1.0 + t)) { hit = true; th = t; break; }
      t += 0.75 * d;
      if (t > t1) break;
    }
  }

  vec3 V = -rd;
  vec3 col;
  if (hit) {
    vec3 pl = ro + th * rl;
    vec3 pw = u_eye + th * rd;
#ifdef TESS_RELIEF
    if (faceHit) {
      col = shadeFace(wHit, etaHit, th / tp, Jpx, side, pw, rd, fpx, jit);
    } else {
#else
    bool face = length(pl.xz) < u_coinG.x && abs(pl.y) > u_coinG.z - 0.003;
    if (face) {
      // The print, raised where the music lifts it: parallax by the height, then its slope.
      g_surf = 0;
      vec2 w = wface;
      vec3 vl = normalize(ro - pf);
      float hgt = faceHeight(w);
      // The slope (for the normal and the parallax), at the unshifted point.
      float e = 0.004;
      float gx = (faceHeight(w + vec2(e, 0.0)) - faceHeight(w - vec2(e, 0.0))) / (2.0 * e * u_coinG.x);
      float gy = (faceHeight(w + vec2(0.0, e)) - faceHeight(w - vec2(0.0, e))) / (2.0 * e * u_coinG.x);
      // Parallax w′ = w + h(w) pc, so dw′ = (I + pc ∇hᵀ) dw. On a bump's far slope that folds the
      // print over itself (a speckle) once pc·∇h < −1, so the shift is scaled to keep it ≥ −0.6;
      // and capped at grazing angles.
      vec2 pc = vec2(vl.x, -side * vl.z) / max(abs(vl.y), 0.6) / u_coinG.x;
      vec2 gw = vec2(gx, gy) * u_coinG.x;
      float k = dot(pc, gw);
      pc *= k < -0.6 ? 0.6 / -k : 1.0;
      w += hgt * pc;
      vec3 nl = normalize(vec3(-gx, 1.0, side * gy)) * vec3(1.0, side, 1.0);
      vec3 N = normalize(transpose(u_coin) * nl);
      float rw = length(w);
      // The parallax stretches or squeezes the print: w′ = w + h(w) pc, so dw′ = (I + pc ∇hᵀ) dw.
      mat2 Jp = (mat2(1.0) + mat2(pc * gw.x, pc * gw.y)) * Jpx;
      float px = sqrt(abs(determinant(Jp)));
      float tileSize = rw < 1.0 ? 0.5 * u_kiteA * (1.0 - rw * rw) / max(px, 1e-6) : 0.0;
      vec3 base = u_tInk;
      float ao = 1.0;
      if (tileSize > 0.6 * fpx) {
        base = mix(u_tInk, diskShade(w, 1.0, Jp, tileSize).rgb, smoothstep(0.6 * fpx, 1.6 * fpx, tileSize));
        // Tiles the beat or the spectrum lifts: lighter tops, deeper cuts round them.
        float lt = u_lift.x * rippleLift(u_kick.x, hdist(g_dk.impactD), u_kick.y) / 0.05 +
                   u_lift.y * specLift(hdist(g_dk.centreD)) / 0.05;
        lt = clamp(lt, 0.0, 2.0);
        float cut = 1.0 - smoothstep(0.0, 5.0 * fpx, g_dk.dpx);
        base *= (1.0 + 0.3 * lt) * (1.0 - 0.35 * lt * cut);
        // The carved outlines' grooves and the music's relief occlude: a tile-scaled groove
        // (faded out where tiles are too small to carve), the ripple and heave around.
        float tw = g_dk.dpx / max(g_dk.dist, 1e-6) * px * u_coinG.x;  // world per tile unit
        float carve = smoothstep(12.0 * fpx, 40.0 * fpx, tileSize);
        ao = mix(1.0, faceAO(w, faceHeight(w), g_dk.dpx * px * u_coinG.x, GROOVE_W * tw), carve);
        // Treble glints along the gouges.
        float x = g_dk.dist / 0.03;
        float idx = floor(x);
        float line = (1.0 - smoothstep(0.08, 0.3, abs(fract(x) - 0.5))) * step(0.5, idx) * step(idx, 6.0);
        line *= smoothstep(3.0, 6.0, 0.03 * g_dk.dpx / max(g_dk.dist, 1e-6));  // gouges under ~4 px apart alias
        float glint = 0.5 + 0.5 * sin(u_treble.y * 23.0 + idx * 2.1 + g_dk.uv.x * 31.0 + g_dk.uv.y * 17.0);
        base += u_treble.x * line * glint * glint * 0.35 * (u_tPaper + 0.2);
      }
      // Lacquered ink: a clear coat over the print — the key light's GGX highlight and the wall
      // in a Fresnel reflection.
      float nl0 = max(dot(N, u_light), 0.0);
      float nv = max(dot(N, V), 1e-3);
      float fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
      // On the music's bumps the reflected wall would be minified to a speckle: it fades to the
      // wall's mean colour as the slope (and so the normal's turn per pixel) grows.
      vec3 refl = mix(wallCheap(pw, reflect(rd, N)), 0.9 * u_tAvg, smoothstep(0.02, 0.12, length(vec2(gx, gy))));
      col = base * (0.66 + 0.34 * nl0) * ao * (1.0 - 0.7 * fr) + 0.7 * fr * refl;
      col += ggx(N, V, u_light, 0.16) * vec3(1.0, 0.97, 0.9) * 0.8;
    } else {
#endif
      // The rim: brushed metal, its streaks running round the circumference.
      vec3 nloc = coinNormal(pl);
      vec3 N = normalize(transpose(u_coin) * nloc);
      float ang = atan(pl.z, pl.x);
      vec3 T = normalize(transpose(u_coin) * vec3(-sin(ang), 0.0, cos(ang)));
      vec3 hv = normalize(u_light + V);
      float th2 = dot(T, hv);
      float streak = tessNoise(vec2(ang * 90.0, pl.y * 60.0 + length(pl.xz) * 240.0));
      float aniso = pow(max(0.0, sqrt(max(0.0, 1.0 - th2 * th2))), 70.0) * max(dot(N, u_light), 0.0);
      vec3 metal = mix(u_tInk, u_tPaper, 0.42) * vec3(1.06, 0.97, 0.82);
      float nv = max(dot(N, V), 1e-3);
      float fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
      col = metal * (0.3 + 0.7 * max(dot(N, u_light), 0.0)) * (0.82 + 0.36 * streak) * rimAO(pl, nloc);
      col += aniso * (0.6 + 0.4 * streak) * vec3(1.0, 0.95, 0.85) * 0.9;
      col = mix(col, wallCheap(pw, reflect(rd, N)), 0.35 * fr + 0.1);
    }
#ifdef TESS_CINEMATIC
    col = tessAtmos(col, 1.0 - exp(-th * u_fog), 1.0 - exp(-th * u_fog));
#else
    col = mix(col, u_tPaper, 1.0 - exp(-th * u_fog));
#endif
  } else {
    // The sphere wall: the cube-sphere print on matte paper with a little tooth, in the fog.
    g_surf = 1;
    g_face = wf;
    col = tessShade(wp, S).rgb;
    vec3 n = -normalize(hw);
    float tooth = tessNoise(wp * 23.0) - 0.5;
    col *= 0.84 + 0.12 * max(dot(n, u_light), 0.0) + 0.06 * tooth;
    col = mix(col, u_tPaper, 0.28);                     // the wall stays quiet: matte paper
#ifdef TESS_CINEMATIC
    col = tessAtmos(col, 1.0 - exp(-tw * u_fog), 1.0 - exp(-tw * u_fog));
#else
    col = mix(col, u_tPaper, 1.0 - exp(-tw * u_fog));
#endif
    // The coin's outline, a key-block line round its silhouette.
    float line = 1.0 - smoothstep(0.6, 1.6, closest / pix / fpx);
    col = mix(col, u_tInk, line * 0.85);
  }
#ifdef TESS_CINEMATIC
  o = vec4(col, tessCoC((hit ? th : tw) * dot(rd, u_cam[2])));
#else
  o = vec4(col, 1.0);
#endif
}
#endif
