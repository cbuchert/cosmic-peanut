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
uniform float u_near;         // 0–1: the camera is close to the coin

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
  if (tp > 0.0 && tp < 1e5 && length(pf.xz) < u_coinG.x) {
    hit = true;
    th = tp;
  } else if (disc > 0.0) {
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
    bool face = length(pl.xz) < u_coinG.x && abs(pl.y) > u_coinG.z - 0.003;
    if (face) {
      // The print, raised where the music lifts it: parallax by the height, then its slope.
      g_surf = 0;
      vec2 w = wface;
      vec3 vl = normalize(ro - pf);
      float hgt = faceHeight(w);
      vec2 shift = hgt * vl.xz / max(abs(vl.y), 0.25) / u_coinG.x;
      w += vec2(shift.x, -side * shift.y);
      float e = 0.004;
      float gx = (faceHeight(w + vec2(e, 0.0)) - faceHeight(w - vec2(e, 0.0))) / (2.0 * e * u_coinG.x);
      float gy = (faceHeight(w + vec2(0.0, e)) - faceHeight(w - vec2(0.0, e))) / (2.0 * e * u_coinG.x);
      vec3 nl = normalize(vec3(-gx, 1.0, side * gy)) * vec3(1.0, side, 1.0);
      vec3 N = normalize(transpose(u_coin) * nl);
      float rw = length(w);
      float px = sqrt(abs(determinant(Jpx)));
      float tileSize = rw < 1.0 ? 0.5 * u_kiteA * (1.0 - rw * rw) / max(px, 1e-6) : 0.0;
      vec3 base = u_tInk;
      if (tileSize > 0.6 * fpx) {
        base = mix(u_tInk, diskShade(w, 1.0, Jpx, tileSize).rgb, smoothstep(0.6 * fpx, 1.6 * fpx, tileSize));
        // Tiles the beat or the spectrum lifts: lighter tops, deeper cuts round them.
        float lt = u_lift.x * rippleLift(u_kick.x, hdist(g_dk.impactD), u_kick.y) / 0.05 +
                   u_lift.y * specLift(hdist(g_dk.centreD)) / 0.05;
        lt = clamp(lt, 0.0, 2.0);
        float cut = 1.0 - smoothstep(0.0, 5.0 * fpx, g_dk.dpx);
        base *= (1.0 + 0.3 * lt) * (1.0 - 0.35 * lt * cut);
        // Carved outlines read as grooves when the camera is close.
        base *= 1.0 - 0.3 * u_near * cut;
        // Treble glints along the gouges.
        float x = g_dk.dist / 0.03;
        float idx = floor(x);
        float line = (1.0 - smoothstep(0.08, 0.3, abs(fract(x) - 0.5))) * step(0.5, idx) * step(idx, 6.0);
        float glint = 0.5 + 0.5 * sin(u_treble.y * 23.0 + idx * 2.1 + g_dk.uv.x * 31.0 + g_dk.uv.y * 17.0);
        base += u_treble.x * line * glint * glint * 0.35 * (u_tPaper + 0.2);
      }
      // Lacquered ink: a clear coat over the print — the key light's GGX highlight and the wall
      // in a Fresnel reflection.
      float nl0 = max(dot(N, u_light), 0.0);
      float nv = max(dot(N, V), 1e-3);
      float fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
      vec3 refl = wallCheap(pw, reflect(rd, N));
      float ao = 1.0 - 0.25 * u_near * smoothstep(0.88, 1.0, rw);
      col = base * (0.66 + 0.34 * nl0) * ao * (1.0 - 0.7 * fr) + 0.7 * fr * refl;
      col += ggx(N, V, u_light, 0.16) * vec3(1.0, 0.97, 0.9) * 0.8;
    } else {
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
      col = metal * (0.3 + 0.7 * max(dot(N, u_light), 0.0)) * (0.82 + 0.36 * streak);
      col += aniso * (0.6 + 0.4 * streak) * vec3(1.0, 0.95, 0.85) * 0.9;
      col = mix(col, wallCheap(pw, reflect(rd, N)), 0.35 * fr + 0.1);
    }
    col = mix(col, u_tPaper, 1.0 - exp(-th * u_fog));
  } else {
    // The sphere wall: the cube-sphere print on matte paper with a little tooth, in the fog.
    g_surf = 1;
    g_face = wf;
    col = tessShade(wp, S).rgb;
    vec3 n = -normalize(hw);
    float tooth = tessNoise(wp * 23.0) - 0.5;
    col *= 0.84 + 0.12 * max(dot(n, u_light), 0.0) + 0.06 * tooth;
    col = mix(col, u_tPaper, 0.28);                     // the wall stays quiet: matte paper
    col = mix(col, u_tPaper, 1.0 - exp(-tw * u_fog));
    // The coin's outline, a key-block line round its silhouette.
    float line = 1.0 - smoothstep(0.6, 1.6, closest / pix / fpx);
    col = mix(col, u_tInk, line * 0.85);
  }
  o = vec4(col, 1.0);
}
