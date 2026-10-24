// Lattice family — shading: light, materials, emission (history, running light, pulses), AO
// and fog. Structure-agnostic: it reads the hit only through the structure's structKind,
// structAxis, structNodeFace, structStrut, pulseMetric and sceneSDF.
//
// Light: a headlight at the camera and a fixed key light (wrapped diffuse + soft specular),
// ambient occlusion from STRUCT_AO_SAMPLES SDF samples, then exponential fog to the background
// (or to transparent). On paper (u_ink) light can't add, so emission mixes toward its colour.
// MATERIALS (Tentacle Lattice): Tentacube's four materials crossfaded by u_mat.
// Output: linear, premultiplied RGBA (post.frag converts to sRGB).
//
// This is the classic look. With CINEMATIC (the Look param) the file is the cinematic look below
// instead (README.md → "Shading"); the classic text is kept verbatim under #else.

#ifdef CINEMATIC
// ================================ Cinematic look ================================================
// brdf.glsl is prepended (the BRDF, split-sum, thin-film and in-scatter functions it cites). Output
// is HDR linear radiance, premultiplied by coverage; post.frag adds bloom and tone-maps.
//
// Lights: a key (directional, cone-traced SDF soft shadow), a headlight at the camera (windowed
// inverse square), the beat pulses as tube lights (lib/lattice-lights.js packs the few nearest),
// and a procedural environment through the split sum. Every surface goes through one BRDF: GGX
// with height-correlated Smith visibility and Kulla–Conty energy compensation, Burley diffuse,
// Belcour–Barla thin film for Tentacle Lattice's iridescent material. Emission (history, running
// light, pulse fronts) is the classic look's, in HDR. The fog is homogeneous and physically
// based: transmittance e^{−βt} and single-scattered light from the background, the key, the
// headlight and the pulses (Sun et al. 2005's analytic point-light integral), so pulses carry
// soft halos and rays that miss everything still see lit haze.

const float PULSE_W = 0.32;     // half-width of a pulse front, cells (as classic)
const int LIGHT_CAP = 12;       // lib/lattice-lights.js LIGHT_CAP
const int SHADOW_CAP = 32;      // ≥ lib/lattice-look.js shadingSamples(...).shadow
const int AO_CAP = 8;           // ≥ shadingSamples(...).ao

uniform vec4 u_ltA[LIGHT_CAP];  // pulse tube lights: end a (xyz)
uniform vec4 u_ltB[LIGHT_CAP];  //   end b (xyz), power (the pulse's amplitude, windowed)
uniform int u_nl;               //   how many
uniform int u_shSteps;          // key-light shadow taps (Quality)
uniform int u_aoN;              // AO taps (Quality)
uniform vec3 u_fogCol;          // the background as HDR: toneInverse(u_bg), so the far fog lands on it
uniform vec3 u_f0;              // the palette's material (lib/lattice-look.js paletteMaterial): f0,
uniform vec2 u_rm;              //   roughness, metalness
#ifdef MATERIALS
uniform vec4 u_mat;             // chrome, iridescent, emissive, obsidian weights
#endif

// A structure hook (optional): scales the lit surface (not its emission). A structure whose walls
// fill the view (minimal surfaces, fractals) can define it < 1 so beat pulses read against them.
#ifndef STRUCT_WALL_TONE
#define STRUCT_WALL_TONE 1.0
#endif

const vec3 KEY_DIR = vec3(0.3487, 0.7971, 0.4483); // normalize(0.35, 0.8, 0.45), as classic
const float KEY_I = 1.3;        // key irradiance
const float SHADOW_K = 10.0;    // penumbra sharpness (cone half-angle ≈ 1/k)
const float SHADOW_FAR = 1.8;   // cells: the key is shadowed by nearby geometry only
const float HEAD_I = 0.7;       // headlight intensity
const float HEAD_RANGE = 10.0;  // its window (cells)
const float PULSE_I = 0.9;      // pulse tube intensity per cell of tube, per unit amplitude
const float PULSE_RANGE = 1.8;  // a pulse light's window (cells)
const float HALO_RANGE = 0.7;   // in-scatter: tubes farther than this from the ray are skipped
const float HALO_I = 1.0;       // a pulse's in-scatter intensity per cell of tube (its fronts' glow,
                                // brighter than the light they cast on the scene)
const float TUBE_R = 0.06;      // a tube's radius (cells): the highlight's widening
const float ENV_I = 0.7;        // environment brightness
const float KEY_FOG = 0.12;     // share of the key reaching the medium (the lattice shadows the rest)
const float HEAD_FOG = 0.5;     // headlight in-scatter weight (back-scatter phase vs isotropic)
const float HEAD_SIZE = 0.6;    // its in-scatter size (cells): a lamp above the eye, not at it
const float EMIT_GAIN = 1.4;    // classic emission → HDR...
const float PULSE_EMIT = 0.45;  // ...but the pulse fronts less: their light also reaches the scene
const float EMISSIVE_GAIN = 0.5; // Tentacle Lattice's emissive material
const float FOG_K = 0.85;       // u_fog (classic's display-space density) → extinction β...
const float FOG_INK = 0.5;      // ...less this share on paper (a light fog mixed in linear light
                                // reads far thicker than in display space, where classic mixes it)
const vec3 CHROME_F0 = vec3(0.55, 0.56, 0.554); // chromium (Hoffman 2015)
const float FILM_ETA = 2.0;     // thin film: a TiO₂-like coating...
const float BASE_ETA = 3.5;     // ...on a dark, high-index base (silicon-like)

struct Surf {
  vec3 kd;      // diffuse albedo
  vec3 f0;      // specular at normal incidence (the non-film part)
  float rough;  // perceptual roughness
  float a;      // α = rough²
  float film;   // weight of the thin-film Fresnel
  vec3 irid;    // the film's reflectance at NoV
};

// The surface's material: the palette's (struts tinted 18 % by their axis, as classic), or with
// MATERIALS Tentacube's four through the same BRDF, their parameters blended by u_mat.
Surf surface(vec3 p, int kind, vec3 axisCol, float NoV) {
  Surf s;
  vec3 albedo = kind == 0 ? u_surf : mix(u_surf, axisCol, 0.18 * (1.0 - u_ink));
  vec3 tint = axisCol / max(1e-4, max(axisCol.r, max(axisCol.g, axisCol.b)));
  float metal = u_rm.y;
  s.f0 = kind == 0 ? u_f0 : mix(u_f0, u_f0 * tint, 0.18 * metal);
  s.kd = albedo * (1.0 - metal);
  s.rough = u_rm.x;
  s.film = 0.0;
  s.irid = vec3(0.0);
#ifdef MATERIALS
  vec4 w = u_mat; // chrome, iridescent, emissive, obsidian
  s.film = w.y;
  if (w.y > 0.0) {
    // Film thickness varies smoothly over the creatures (absolute cells, so it never pops).
    vec3 pa = p + u_origin;
    float dnm = 330.0 + 130.0 * sin(dot(pa, vec3(0.9, 1.3, 0.7)) + 2.0 * sin(dot(pa, vec3(0.5, -0.8, 1.1))));
    s.irid = thinFilm(NoV, FILM_ETA, BASE_ETA, dnm);
  }
  s.f0 = (w.x * CHROME_F0 + (w.z + w.w) * vec3(0.04)) / max(1e-4, 1.0 - w.y);
  s.kd = w.y * vec3(0.01) + w.z * albedo + w.w * vec3(0.004);
  s.rough = w.x * 0.08 + w.y * 0.2 + w.z * 0.5 + w.w * 0.05;
  // On paper: mostly ink (a matte dielectric of the palette's surface colour).
  float k = 0.7 * u_ink;
  s.kd = mix(s.kd, albedo, k);
  s.f0 = mix(s.f0, vec3(0.04), k);
  s.rough = mix(s.rough, 0.55, k);
  s.film *= 1.0 - k;
#endif
  s.a = max(s.rough * s.rough, 0.002);
  return s;
}

// Diffuse + specular of a light from unit direction l (radiance scale applied by the caller).
vec3 lightBRDF(Surf s, vec3 n, vec3 v, vec3 l, float NoV, vec3 ec) {
  float NoL = dot(n, l);
  if (NoL <= 0.0) return vec3(0.0);
  vec3 h = normalize(v + l);
  float NoH = max(dot(n, h), 0.0);
  float LoH = max(dot(l, h), 0.0);
  vec3 F = mix(fSchlick(s.f0, LoH), s.irid, s.film);
  vec3 spec = dGGX(NoH, s.a) * vSmithCorrelated(NoV, NoL, s.a) * F * ec;
  return (s.kd * fdBurley(NoV, NoL, LoH, s.rough) + spec) * NoL;
}

// The procedural environment, prefiltered by roughness: a fog-to-light gradient whose edge widens
// with roughness, and soft light panels whose contrast falls with it (the split sum's first term).
vec3 envRadiance(vec3 d, float rough) {
  float w = 0.3 + 1.1 * rough;
  vec3 top = mix(mix(u_glow, u_surf, 0.4) * ENV_I, u_fogCol * 0.3, u_ink);
  vec3 sky = mix(u_fogCol * (0.6 - 0.45 * u_ink), top, smoothstep(-w, w, d.y));
  float panel = pow(max(0.0, sin(d.x * 5.0) * sin(d.z * 5.0 + 1.0)), mix(6.0, 1.5, rough));
  return sky + panel * (0.5 * (1.0 - rough) * (1.0 - u_ink) * ENV_I) * u_glow;
}

// Ambient occlusion from the distance field (Evans, "Fast Approximations for Global Illumination on
// Dynamic Scenes", SIGGRAPH 2006 course): sample along the normal, occlusion where the field is
// smaller than the distance travelled, weights halving outward. Improved: the taps are spaced
// geometrically (fine contact and broad occlusion with few taps) and each is normalized by its
// distance, so every scale counts alike.
float occlusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float wsum = 0.0;
  float w = 1.0;
  float h = 0.6 * STRUCT_AO_SPACING;
  for (int i = 0; i < AO_CAP; i++) {
    if (i >= u_aoN) break;
    occ += w * clamp((h - sceneSDF(p + n * h)) / h, 0.0, 1.0);
    wsum += w;
    w *= 0.6;
    h *= 1.75;
  }
  return clamp(1.0 - 1.3 * occ / max(wsum, 1e-4), 0.0, 1.0);
}

// The key light's soft shadow, cone-traced through the distance field: the narrowest cone of
// half-angle ≈ d / t that the field leaves free along the shadow ray sets the penumbra (Quilez,
// "penumbra shadows in raymarched SDFs", 2010), with the closest approach between successive
// sample spheres estimated by triangulation (Aaltonen, "GPU-based clay simulation and ray-tracing
// tech in Claybook", GDC 2018). Steps keep the structure's structStep guarantee.
float keyShadow(vec3 p, vec3 n) {
  vec3 o = p + n * 0.004;
  float res = 1.0;
  float t = 0.02;
  float ph = 1e10;
  for (int i = 0; i < SHADOW_CAP; i++) {
    if (i >= u_shSteps) break;
    float h = sceneSDF(o + KEY_DIR * t);
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, SHADOW_K * d / max(1e-4, t - y));
    ph = h;
    t += clamp(structStep(h), 0.03, 0.4);
    if (res < 0.01 || t > SHADOW_FAR) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}

// The beat pulses' tube lights on the surface (Karis 2013): diffuse from the line light's
// irradiance approximation 2 (n·L0/2|L0| + n·L1/2|L1|) / (|L0||L1| + L0·L1), specular from the
// representative point (the point of the tube nearest the reflection ray) with its lobe widened by
// the tube's radius (α' = α + r / 2d, normalized by α / α'). A point light (a = b) counts as half a
// cell of tube.
vec3 pulseLights(Surf s, vec3 p, vec3 n, vec3 v, vec3 r, float NoV, vec3 ec) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < LIGHT_CAP; i++) {
    if (i >= u_nl) break;
    vec3 a = u_ltA[i].xyz;
    vec3 ab = u_ltB[i].xyz - a;
    float ll = dot(ab, ab);
    vec3 q = a + ab * clamp(dot(p - a, ab) / max(ll, 1e-6), 0.0, 1.0);
    float dq = length(q - p);
    float I = u_ltB[i].w * PULSE_I * max(sqrt(ll), 0.5);
    if (dq > PULSE_RANGE || I <= 0.0) continue;
    float win = windowFalloff(dq, PULSE_RANGE) * (dq * dq + 0.01);
    // Diffuse.
    vec3 L0 = a - p;
    vec3 L1 = L0 + ab;
    float l0 = length(L0);
    float l1 = length(L1);
    float nol = clamp(0.5 * (dot(n, L0) / l0 + dot(n, L1) / l1), 0.0, 1.0);
    float irr = 2.0 * nol / max(l0 * l1 + dot(L0, L1), 1e-4);
    vec3 ld = (q - p) / max(dq, 1e-4);
    vec3 hd = normalize(v + ld);
    sum += s.kd * fdBurley(NoV, max(dot(n, ld), 0.0), max(dot(ld, hd), 0.0), s.rough) * irr * I * win;
    // Specular: the representative point.
    float rab = dot(r, ab);
    float tt = clamp((dot(r, L0) * rab - dot(L0, ab)) / max(ll - rab * rab, 1e-6), 0.0, 1.0);
    vec3 Lr = L0 + tt * ab;
    float dr = length(Lr);
    vec3 l = Lr / dr;
    float NoL = dot(n, l);
    if (NoL <= 0.0) continue;
    float ap = clamp(s.a + TUBE_R / (2.0 * dr), 0.0, 1.0);
    vec3 h = normalize(v + l);
    vec3 F = mix(fSchlick(s.f0, max(dot(l, h), 0.0)), s.irid, s.film);
    vec3 spec = dGGX(max(dot(n, h), 0.0), ap) * (s.a / ap) * vSmithCorrelated(NoV, NoL, s.a) * F * ec;
    sum += spec * NoL * I * windowFalloff(dr, PULSE_RANGE);
  }
  return sum;
}

// Light scattered toward the eye along the ray from ro over [0, t] (transmittance T there): the
// background fog and the key light (homogeneous medium, single scattering: (1 − T) × source ×
// phase), the headlight and the pulse tubes (Sun et al. 2005, each tube as a point light at its
// point nearest the ray).
vec3 inscatter(vec3 ro, vec3 rd, float t, float T, float beta) {
  float lit = 1.0 - u_ink; // on paper light doesn't add
  vec3 keyCol = mix(vec3(1.0), u_glow, 0.25);
  vec3 L = (1.0 - T) * (u_fogCol * u_bgA + lit * KEY_FOG * phaseHG(dot(rd, KEY_DIR), 0.3) * KEY_I * keyCol);
  vec3 hp = u_cam + u_up * 0.12;
  L += lit * airlight(ro, rd, t, hp, vec3(HEAD_I * HEAD_FOG), beta, HEAD_SIZE);
  for (int i = 0; i < LIGHT_CAP; i++) {
    if (i >= u_nl) break;
    vec3 a = u_ltA[i].xyz;
    vec3 ab = u_ltB[i].xyz - a;
    float C = dot(ab, ab);
    vec3 w = ro - a;
    float B = dot(rd, ab);
    float den = C - B * B;
    float u = den > 1e-6 ? clamp((dot(ab, w) - B * dot(rd, w)) / den, 0.0, 1.0) : 0.0;
    float s = clamp(B * u - dot(rd, w), 0.0, t);
    u = C > 1e-6 ? clamp(dot(ab, w + rd * s) / C, 0.0, 1.0) : 0.0;
    vec3 q = a + ab * u;
    float hq = length(ro + rd * s - q);
    float I = u_ltB[i].w * HALO_I * max(sqrt(C), 0.5);
    if (hq > HALO_RANGE || I <= 0.0) continue;
    float fade = 1.0 - smoothstep(0.6 * HALO_RANGE, HALO_RANGE, hq);
    L += (lit * fade) * airlight(ro, rd, t, q, I * u_glow, beta, 0.1);
  }
  return L;
}

// History texel `age` rows before the newest, at band position u (0–1).
vec4 hist(float u, float age) {
  age = clamp(age, 0.0, u_rows - 2.0);
  return texture(u_hist, vec2(u, fract((u_head - age + 0.5) / u_rows)));
}

// Beat pulses at a surface's pulseAt (as classic): the front and its wake.
float pulses(vec3 pr) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = u_pamp[i];
    if (a <= 0.0) continue;
    float l1 = pulseMetric(pr, u_pulse[i].xyz);
    float x = (l1 - u_pulse[i].w) / PULSE_W;
    float wake = l1 < u_pulse[i].w ? 0.35 * exp(-(u_pulse[i].w - l1) * 1.6) : 0.0;
    s += a * (exp(-x * x) + wake);
  }
  return s;
}

// A ray that hit nothing within u_far: the fog beyond, and the light scattered along the way.
vec4 shadeMiss(vec3 ro, vec3 rd) {
  float beta = u_fog * FOG_K * (1.0 - FOG_INK * u_ink);
  float T = exp(-u_far * beta);
  return vec4(inscatter(ro, rd, u_far, T, beta) + T * u_fogCol * u_bgA, u_bgA);
}

// Shade the hit at distance `t` along the ray (`id`: the structure's material id there).
vec4 shade(vec3 ro, vec3 rd, float t, int id) {
  float beta = u_fog * FOG_K * (1.0 - FOG_INK * u_ink);
  float T = exp(-t * beta);
  float fade = 1.0;
#ifdef STRUCT_FAR_FADE
  // The march stops at u_far: fade into the fog before it, so there's no edge.
  fade = 1.0 - smoothstep(0.7 * u_far, u_far, t);
#endif

  vec3 p = ro + rd * t;
  vec3 n = calcNormal(p);
  int kind = structKind(id);
  int axis = structAxis(id);
  vec3 v = -rd;
  float NoV = max(dot(n, v), 1e-4);
  vec3 r = reflect(rd, n);
  float ao = occlusion(p, n);
  vec3 axisCol = axis == 0 ? u_ax : axis == 1 ? u_ay : u_az;
  float axisLight = axis == 0 ? u_light.x : axis == 1 ? u_light.y : u_light.z;
  Surf s = surface(p, kind, axisCol, NoV);
  vec2 dfg = dfgFit(NoV, s.rough);
  vec3 ec = energyComp(mix(s.f0, s.irid, s.film), dfg);
  vec3 Fenv = mix(s.f0 * dfg.x + dfg.y, s.irid * (dfg.x + dfg.y), s.film);

  // Direct light: key (soft shadow), headlight, pulse tubes.
  vec3 keyCol = mix(vec3(1.0), u_glow, 0.25);
  vec3 col = vec3(0.0);
  if (dot(n, KEY_DIR) > 0.0) col += lightBRDF(s, n, v, KEY_DIR, NoV, ec) * (KEY_I * keyShadow(p, n)) * keyCol;
  vec3 hl = u_cam + u_up * 0.12 - p;
  float hd = length(hl);
  col += lightBRDF(s, n, v, hl / hd, NoV, ec) * (HEAD_I * windowFalloff(hd, HEAD_RANGE));
  col += pulseLights(s, p, n, v, r, NoV, ec) * u_glow * (1.0 - u_ink);
  // Environment: split sum (prefiltered radiance × the DFG fit, energy-compensated), occluded.
  col += s.kd * envRadiance(n, 1.0) * ao + envRadiance(r, s.rough) * Fenv * ec * specOcclusion(NoV, ao, s.rough);
  col *= STRUCT_WALL_TONE;

  // Emission (the classic look's, in HDR).
  vec3 e = vec3(0.0);
  if (kind == 0) {
    vec2 histAt;
    float histWave;
    float histEdge;
    vec3 pulseAt;
    structNodeFace(p, n, id, histAt, histWave, histEdge, pulseAt);
    float band = histAt.x;
    vec4 h = hist(band, histAt.y);
    float inside = smoothstep(1.0, STRUCT_HIST_FADE, histEdge);
    float level = mix(h.r * h.r * 1.4, abs(h.g - 0.5) * 2.4, histWave);
    vec3 tint = band < 0.5 ? mix(u_ax, u_ay, band * 2.0) : mix(u_ay, u_az, band * 2.0 - 1.0);
    e += tint * level * inside * (STRUCT_HIST_GAIN - STRUCT_HIST_INK * u_ink);
    e += u_glow * pulses(pulseAt) * (STRUCT_NODE_PULSE_GAIN * PULSE_EMIT);
  } else {
    float runPhase;
    vec3 pulseAt;
    structStrut(p, n, id, runPhase, pulseAt);
    float run = pow(0.5 + 0.5 * cos(6.2831853 * (runPhase - u_time * 0.6)), 10.0);
    e += axisCol * axisLight * (0.03 + STRUCT_RUN_GAIN * run);
    e += u_glow * pulses(pulseAt) * (STRUCT_PULSE_GAIN * PULSE_EMIT);
  }
  e *= EMIT_GAIN;
#ifdef MATERIALS
  // Tentacube's emissive material glows its axis colour (the node faces: the pulse colour).
  e += u_mat.z * (kind == 0 ? u_glow : axisCol) * ((0.55 + 0.35 * NoV) * (1.0 - 0.7 * u_ink) * EMISSIVE_GAIN);
#endif

  // Light adds; on paper, ink mixes toward its colour (as classic, its colour mapped back to HDR).
  float amount = clamp(max(e.r, max(e.g, e.b)) * (0.6 / EMIT_GAIN), 0.0, 0.9);
  vec3 inked = mix(col, toneInverse(e / max(1e-4, max(e.r, max(e.g, e.b))) * 0.85), amount);
  col = mix(col + e, inked, u_ink);

  // Fog: the surface through the medium plus the light scattered along the way.
  T *= fade;
  vec3 L = col * T + inscatter(ro, rd, t, T, beta);
  return vec4(L, u_bgA > 0.5 ? 1.0 : T);
}

#else
// ================================ Classic look (unchanged) ======================================

const float PULSE_W = 0.32;    // half-width of a pulse front, cells

#ifdef MATERIALS
uniform vec4 u_mat;       // chrome, iridescent, emissive, obsidian weights

// A simple procedural environment for chrome and obsidian: fog below, light above, soft panels.
vec3 envMap(vec3 r) {
  vec3 sky = mix(u_bg * 0.8 + 0.02, mix(u_glow, u_surf, 0.4), smoothstep(-0.4, 0.9, r.y));
  float panel = pow(max(0.0, sin(r.x * 5.0) * sin(r.z * 5.0 + 1.0)), 6.0);
  return sky + panel * 0.5 * u_glow;
}
#endif

float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 1; i <= STRUCT_AO_SAMPLES; i++) {
    float h = 0.02 + STRUCT_AO_SPACING * float(i);
    occ += (h - sceneSDF(p + n * h)) * w;
    w *= 0.7;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

// Beat pulses at a surface's pulseAt: a bright front where the structure's pulseMetric from the
// pulse's source equals its front distance, with a short glowing wake behind it.
float pulses(vec3 pr) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = u_pamp[i];
    if (a <= 0.0) continue;
    float l1 = pulseMetric(pr, u_pulse[i].xyz);
    float x = (l1 - u_pulse[i].w) / PULSE_W;
    // A bright front and a short glowing wake behind it.
    float wake = l1 < u_pulse[i].w ? 0.35 * exp(-(u_pulse[i].w - l1) * 1.6) : 0.0;
    s += a * (exp(-x * x) + wake);
  }
  return s;
}

// History texel `age` rows before the newest, at band position u (0–1).
vec4 hist(float u, float age) {
  age = clamp(age, 0.0, u_rows - 2.0);
  return texture(u_hist, vec2(u, fract((u_head - age + 0.5) / u_rows)));
}

// Shade the hit at distance `t` along the ray (`id`: the structure's material id there).
vec4 shade(vec3 ro, vec3 rd, float t, int id) {
  float fogT = exp(-t * u_fog);
#ifdef STRUCT_FAR_FADE
  // The march stops at u_far: fade into the fog before it, so there's no edge.
  fogT *= 1.0 - smoothstep(0.7 * u_far, u_far, t);
#endif

  vec3 p = ro + rd * t;
  vec3 n = calcNormal(p);
  int kind = structKind(id);
  int axis = structAxis(id);
  float ao = ambientOcclusion(p, n);

  // Albedo: the struts carry a little of their axis colour.
  vec3 axisCol = axis == 0 ? u_ax : axis == 1 ? u_ay : u_az;
  float axisLight = axis == 0 ? u_light.x : axis == 1 ? u_light.y : u_light.z;
  vec3 albedo = kind == 0 ? u_surf : mix(u_surf, axisCol, 0.18 * (1.0 - u_ink));

  // Lighting: headlight (falls off with distance) + key + sky/ground ambient.
  vec3 v = -rd;
  vec3 key = normalize(vec3(0.35, 0.8, 0.45));
  float head = 1.0 / (1.0 + 0.12 * t * t);
  float difH = max(0.0, dot(n, v)) * 0.75 + 0.25;
  float difK = clamp(dot(n, key) * 0.5 + 0.5, 0.0, 1.0);
  vec3 hK = normalize(key + v);
  float spec = pow(max(0.0, dot(n, v)), 24.0) * head + 0.5 * pow(max(0.0, dot(n, hK)), 32.0);
  float amb = 0.5 + 0.5 * n.y;
  vec3 col = albedo * (0.95 * difH * head + 0.22 * difK + 0.06 * amb) * ao;
  col += (1.0 - u_ink) * spec * mix(vec3(1.0), albedo, 0.6) * 0.6 * ao;
#ifdef MATERIALS
  // Materials (Tentacube's four), crossfaded by u_mat.
  float ndv = max(0.0, dot(n, v));
  float fres = pow(1.0 - ndv, 4.0);
  vec3 r = reflect(rd, n);
  float light = 0.95 * difH * head + 0.22 * difK + 0.06 * amb;
  vec3 chrome = envMap(r) * (0.5 + 0.5 * fres) * (0.4 + 0.6 * head) + spec * 0.8;
  vec3 film = 0.5 + 0.5 * cos(6.2831853 * (vec3(0.0, 0.33, 0.67) + 1.6 * (1.0 - ndv) + 0.25 * r.y));
  vec3 irid = film * (0.25 + 0.75 * light) + spec * 0.7;
  vec3 glowCol = kind == 0 ? u_glow : axisCol;
  vec3 emiss = albedo * light * 0.25 + glowCol * (0.55 + 0.35 * ndv);
  vec3 obsid = vec3(0.012) * light + envMap(r) * fres * 0.3 +
               pow(max(0.0, dot(n, hK)), 120.0) * 1.2 + pow(ndv, 80.0) * head * 0.8;
  col = (u_mat.x * chrome + u_mat.y * irid + u_mat.z * emiss + u_mat.w * obsid) * ao;
  col = mix(col, albedo * light * ao, u_ink * 0.7); // on paper: mostly ink
#endif

  // Emission.
  vec3 e = vec3(0.0);
  if (kind == 0) {
    // Node faces: the history, tinted by band; and the pulse fronts passing through the node.
    // (The structure is asked inside this branch: hoisting the call changes the rounding.)
    vec2 histAt;
    float histWave;
    float histEdge;
    vec3 pulseAt;
    structNodeFace(p, n, id, histAt, histWave, histEdge, pulseAt);
    float band = histAt.x;
    vec4 h = hist(band, histAt.y);
    float inside = smoothstep(1.0, STRUCT_HIST_FADE, histEdge);
    float level = mix(h.r * h.r * 1.4, abs(h.g - 0.5) * 2.4, histWave);
    vec3 tint = band < 0.5 ? mix(u_ax, u_ay, band * 2.0) : mix(u_ay, u_az, band * 2.0 - 1.0);
    e += tint * level * inside * (STRUCT_HIST_GAIN - STRUCT_HIST_INK * u_ink);
    e += u_glow * pulses(pulseAt) * STRUCT_NODE_PULSE_GAIN;
  } else {
    // Struts: a running light, brighter with the axis's band energy; and the pulse fronts.
    float runPhase;
    vec3 pulseAt;
    structStrut(p, n, id, runPhase, pulseAt);
    float run = pow(0.5 + 0.5 * cos(6.2831853 * (runPhase - u_time * 0.6)), 10.0);
    e += axisCol * axisLight * (0.03 + STRUCT_RUN_GAIN * run);
    e += u_glow * pulses(pulseAt) * STRUCT_PULSE_GAIN;
  }

  // Additive light (tone-mapped) or, on paper, ink mixed toward its colour.
  vec3 lit = 1.0 - exp(-1.15 * (col + e));
  float amount = clamp(max(e.r, max(e.g, e.b)) * 0.6, 0.0, 0.9);
  vec3 inked = mix(col, e / max(1e-4, max(e.r, max(e.g, e.b))) * 0.85, amount);
  col = mix(lit, inked, u_ink);

  // Fog: toward the background, mixed in display space (in linear light a light fog reads far
  // thicker than it is), or toward transparent (premultiplied alpha: the page blends it in
  // display space too).
  const vec3 G = vec3(1.0 / 2.2);
  vec3 fogged = pow(mix(pow(u_bg, G), pow(max(col, 0.0), G), fogT), vec3(2.2));
  return u_bgA > 0.5 ? vec4(fogged, 1.0) : vec4(col * fogT, fogT);
}
#endif
