// The cinematic Look's shading for the tessellation surfaces (lib/tess-look.js holds its tested
// constants and mirrors; lib/tess-gl.js compiles a surface with TESS_CINEMATIC for it). A surface
// includes it with `// #include look` after the engine and after its own height look-up (the
// horizon AO calls it through TESS_AO_HEIGHT). Everything here is under TESS_CINEMATIC, so a
// classic program's text compiles exactly as it did.
//
// The print becomes a physical object under the surface's raking light:
//   ink    the inked tops (tile colours, key-block outlines): Burley's diffuse (Burley, "Physically
//          Based Shading at Disney", SIGGRAPH 2012 course) plus a satin GGX lobe (Walter et al.,
//          "Microfacet Models for Refraction through Rough Surfaces", EGSR 2007) with the
//          height-correlated Smith visibility (Heitz, "Understanding the Masking-Shadowing
//          Function in Microfacet-Based BRDFs", JCGT 2014) and Schlick's Fresnel, F0 0.045 (an
//          oil-based ink, IOR ~1.5), so a raking light glints on carved, inked surfaces;
//   paper  where the cuts show the paper: rough, a wrap diffuse (Green, "Real-Time
//          Approximations to Subsurface Scattering", GPU Gems 2004, ch. 16) for the light the
//          sheet carries round its fibres, no specular;
//   wood   the relief's cut sides: bare end grain (rings and pores), rough, unlit by ink.
// Flat tops in full light keep the classic print's exposure: each surface passes its own
// ambient, key and the flat surface's N·L, and the diffuse terms are normalised by their value on
// the flat surface, so the palettes print as they do in classic and only the shape changes.
#ifdef TESS_CINEMATIC
uniform vec4 u_kFocus;      // focus depth, aperture (target px far away), cap (target px), 0
uniform ivec4 u_kSamples;   // horizon-AO directions, steps per direction, shadow steps at most, 0

// Signed circle of confusion (diameter, target px) at view depth z: thin lens, near < 0 < far
// (lib/tess-look.js circleOfConfusion). Surfaces with depth of field write it to alpha.
float tessCoC(float z) {
  if (u_kFocus.y <= 0.0) return 0.0;
  return clamp(u_kFocus.y * (1.0 - u_kFocus.x / max(z, 1e-6)), -u_kFocus.z, u_kFocus.z);
}

// The surfaces' shadow loops run at most u_kSamples.z steps in cinematic (≤ 8).
int tessShadowSteps(int n) { return min(n, u_kSamples.z); }

#define K_PI 3.14159265359
#define INK_F0 0.045
#define INK_F90 0.3
#define INK_ROUGH 0.55      // perceptual roughness of the ink film: satin
#define INK_SHEEN 0.7       // the lobe's strength (1: the physical key light)
#define INK_DIFF_ROUGH 0.6  // Burley's roughness for the ink's diffuse
#define PAPER_WRAP 0.35     // Green's wrap for the paper
#define PAPER_FIBRE 0.06    // fibre relief on the paper's light
#define WOOD_DARK 1.0       // end grain drinks the light: darker than the plank's face

float tessGGX(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (K_PI * d * d);
}
// Heitz 2014's height-correlated Smith G2 / (4 N·L N·V).
float tessSmithVis(float nl, float nv, float a) {
  float a2 = a * a;
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
// Schlick's Fresnel towards f90 at grazing: 1 for a smooth film; a satin ink's micro-roughness
// scatters the grazing reflection, so it rises only to INK_F90 (no glassy haze on the far floor).
float tessSchlick(float f0, float f90, float vh) {
  float m = 1.0 - vh;
  float m2 = m * m;
  return f0 + (f90 - f0) * m2 * m2 * m;
}
// Burley's diffuse × N·L (without the 1/π, which the key's normalisation absorbs).
float tessBurley(float nl, float nv, float lh, float r) {
  float f90 = 0.5 + 2.0 * r * lh * lh;
  float ml = 1.0 - nl;
  float mv = 1.0 - nv;
  float fl = 1.0 + (f90 - 1.0) * ml * ml * ml * ml * ml;
  float fv = 1.0 + (f90 - 1.0) * mv * mv * mv * mv * mv;
  return fl * fv * nl;
}
// Green's wrap diffuse: light reaches a little past the terminator, as through a fibrous sheet.
float tessWrap(float nl, float w) { return max(0.0, (nl + w) / (1.0 + w)); }

// Bare end grain at a point of the block (plane xy, height z; px = plane units per target px):
// annual rings across the block and open pores, fading to the plain wood tone before they alias.
vec3 tessEndGrain(vec3 P, float px) {
  vec3 wood = mix(vec3(0.24, 0.14, 0.07), u_tAvg, 0.2) * WOOD_DARK;    // pear end grain, a little ink-stained
  float wob = tessNoise(P.xy * 3.1) * 1.6;
  float ring = 0.5 + 0.5 * sin(TAU * (length(P.xy * vec2(1.0, 0.37) + 7.3) * 21.0 + wob));
  float pore = tessNoise(vec2(P.x + P.y, P.z * 0.4) * 230.0);
  float vis = smoothstep(1.5, 4.0, (1.0 / 21.0) / max(px, 1e-6));        // ring spacing in px
  float pvis = smoothstep(1.5, 3.0, (1.0 / 230.0) / max(px, 1e-6));
  return wood * (1.0 - 0.16 * vis * smoothstep(0.55, 1.0, ring) - 0.22 * pvis * smoothstep(0.62, 0.9, pore));
}

// End grain only where there is a cut side (the caller's weight): the rest pays nothing for it.
vec3 tessWood(float wall, vec3 P, float px) { return wall > 0.0 ? tessEndGrain(P, px) : vec3(0.0); }

// The lit print. c: the print's colour; paper: how much of it is paper showing through the cuts
// (tessPrintFill's g_tessPaper); wood: how much is a bare cut side (its colour is `woodCol`);
// N the carved normal, N0 the flat surface's, V towards the eye, L towards the light; shadow and
// ao 0–1; amb, key and nl0 the surface's classic ambient, key share and flat N·L (a flat top in
// full light prints at its colour). Returns linear radiance.
vec3 tessLookShade(vec3 c, float paper, float wood, vec3 woodCol, vec3 N, vec3 N0, vec3 V, vec3 L,
                   float shadow, float ao, float amb, float key, float nl0) {
  float nl = max(dot(N, L), 0.0);
  float nv = max(dot(N, V), 1e-3);
  vec3 H = normalize(L + V);
  float lh = max(dot(L, H), 0.0);
  float nh = max(dot(N, H), 0.0);
  float nl0c = max(nl0, 0.05);
  float nv0 = max(dot(N0, V), 1e-3);
  float lh0 = lh;
  // Each material's diffuse over its own value on the flat surface in the same light.
  float dInk = tessBurley(nl, nv, lh, INK_DIFF_ROUGH) / max(tessBurley(nl0c, nv0, lh0, INK_DIFF_ROUGH), 1e-3);
  float dPaper = tessWrap(nl, PAPER_WRAP) / tessWrap(nl0c, PAPER_WRAP);
  float dWood = nl / nl0c;
  float d = mix(mix(dInk, dPaper, paper), dWood, wood);
  vec3 alb = mix(c, woodCol, wood);
  // Micro-shadowing: the AO's cone also hides some of the key light in the grooves (Chan,
  // "Material Advances in Call of Duty: WWII", SIGGRAPH 2018 Advances: saturate(|N·L| + 2 ao² − 1)).
  float micro = clamp(abs(dot(N, L)) + 2.0 * ao * ao - 1.0, 0.0, 1.0);
  vec3 col = alb * (amb * ao + key * min(d * shadow * micro, 1.6));
  // The ink's satin lobe, under the same key: E = π key / nl0 (the diffuse's normalisation).
  float a = INK_ROUGH * INK_ROUGH;
  float spec = tessGGX(nh, a) * tessSmithVis(nl, nv, a) * tessSchlick(INK_F0, INK_F90, lh) * nl;
  float inked = (1.0 - paper) * (1.0 - wood);
  col += vec3(spec * inked * INK_SHEEN * K_PI * key / nl0c * shadow * micro);
  return col;
}

// Atmosphere: fog takes the paper's colour, a touch cooler and lighter with depth (0 near … 1 at
// the fog's end), as distance does to ink on a printed horizon.
vec3 tessAtmos(vec3 col, float fog, float depth) {
  vec3 far = mix(u_tPaper, u_tPaper * vec3(0.95, 0.975, 1.0) + 0.02, clamp(depth, 0.0, 1.0));
  return mix(col, far, clamp(fog, 0.0, 1.0));
}

#ifdef TESS_AO_HEIGHT
// Horizon-based ambient occlusion on the relief's height field (after Bavoil & Sainz,
// "Image-Space Horizon-Based Ambient Occlusion", SIGGRAPH 2008 talk): in each of u_kSamples.x
// directions round the point, step out to `radius` (plane units) reading the height
// (TESS_AO_HEIGHT(offset), plane units; the surface defines it from its own map) and raise the
// horizon; each rise adds its sine gain × the falloff 1 − r²/R². The tangent's slope along the
// direction (grad · dir) is the horizon's start, so a bevel doesn't occlude itself.
#define AO_DIRS_MAX 8
#define AO_STEPS_MAX 4
float tessHorizonAO(float h0, vec2 grad, float radius, float jit) {
  int nd = u_kSamples.x;
  int ns = u_kSamples.y;
  float occ = 0.0;
  for (int i = 0; i < AO_DIRS_MAX; i++) {
    if (i >= nd) break;
    float ang = TAU * (float(i) + jit) / float(nd);
    vec2 dir = vec2(cos(ang), sin(ang));
    float tt = dot(grad, dir);
    float sinH = tt / sqrt(1.0 + tt * tt);
    float o = 0.0;
    for (int j = 0; j < AO_STEPS_MAX; j++) {
      if (j >= ns) break;
      float r = radius * (float(j) + 0.5 + 0.5 * jit) / float(ns);
      float dh = TESS_AO_HEIGHT(dir * r) - h0;
      float sh = dh / sqrt(dh * dh + r * r);
      if (sh > sinH) {
        float f = r / radius;
        o += (1.0 - f * f) * (sh - sinH);
        sinH = sh;
      }
    }
    occ += o;
  }
  return clamp(1.0 - 1.3 * occ / float(max(nd, 1)), 0.3, 1.0);
}
#endif
#endif
