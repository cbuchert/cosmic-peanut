// Lattice family — the cinematic look's shading library (pure functions; prepended to shade.glsl
// when the Look is cinematic). Each piece cites the paper it is built from.

const float PI = 3.14159265;

float pow5(float x) {
  float x2 = x * x;
  return x2 * x2 * x;
}

// ---- Microfacet specular -------------------------------------------------------------------
// GGX / Trowbridge-Reitz distribution (Walter et al. 2007), with the perceptual roughness remap
// α = roughness² (Burley, "Physically Based Shading at Disney", SIGGRAPH 2012 course; Karis, "Real
// Shading in Unreal Engine 4", SIGGRAPH 2013 course).
float dGGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * d * d);
}

// Smith's height-correlated masking-shadowing for GGX, folded with the 1 / (4 NoL NoV) of the
// microfacet BRDF: V = G2 / (4 NoL NoV) (Heitz, "Understanding the Masking-Shadowing Function",
// JCGT 2014; used in this form by Lagarde & de Rousiers, "Moving Frostbite to PBR", SIGGRAPH 2014).
float vSmithCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// Schlick's Fresnel (Karis 2013 uses it with f90 = 1).
vec3 fSchlick(vec3 f0, float VoH) {
  return f0 + (1.0 - f0) * pow5(1.0 - VoH);
}

// ---- Diffuse --------------------------------------------------------------------------------
// Burley's (Disney) diffuse: Lambert with a retro-reflective rise at grazing angles for rough
// surfaces, f90 = 0.5 + 2 roughness cos²θd (Burley 2012).
float fdBurley(float NoV, float NoL, float LoH, float rough) {
  float f90 = 0.5 + 2.0 * rough * LoH * LoH;
  return (1.0 + (f90 - 1.0) * pow5(1.0 - NoL)) * (1.0 + (f90 - 1.0) * pow5(1.0 - NoV)) / PI;
}

// ---- Split-sum environment lighting ----------------------------------------------------------
// The pre-integrated DFG term of Karis's split sum (2013) as an analytic fit instead of a LUT
// texture (Karis, "Physically Based Shading on Mobile", 2014): specular = prefiltered env ×
// (f0 · x + y) with (x, y) = dfgFit(NoV, roughness).
vec2 dfgFit(float NoV, float rough) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

// Multiple-scattering energy compensation (Kulla & Conty, "Revisiting Physically Based Shading at
// Imageworks", SIGGRAPH 2017 course): single-scattering GGX loses the energy that bounces between
// microfacets, 1 − E(μ), so rough metals darken. With the directional albedo E = x + y of the same
// DFG fit, scaling the specular lobe by 1 + f0 (1 / E − 1) restores it (the analytic form of the
// compensation lobe used by Fdez-Agüera, JCGT 2019, and Turquin, 2019).
vec3 energyComp(vec3 f0, vec2 dfg) {
  return 1.0 + f0 * (1.0 / max(dfg.x + dfg.y, 1e-3) - 1.0);
}

// Specular occlusion from ambient occlusion (Lagarde & de Rousiers 2014).
float specOcclusion(float NoV, float ao, float rough) {
  return clamp(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
}

// ---- Thin-film iridescence (Belcour & Barla, "A Practical Extension to Microfacet Theory for the
// Modeling of Varying Iridescence", SIGGRAPH 2017) ------------------------------------------------
// A dielectric film (IOR eta2, thickness d) over a dielectric base (eta3). With the signed
// amplitude coefficients a = r12, b = r23 (r21 = −a, t12 t21 = T = 1 − a²), the Airy sum of the
// reflected amplitude is r = a + T b z / (1 + a b z), z = e^{iΦ}, Φ = 2π · OPD / λ. Its intensity
// as a Fourier series in Φ is
//   R = A0 + 2 Σ_k A_k cos(kΦ),   A0 = a² + T² b² / (1 − a² b²),   A_k = (−ab)^k (T² b² / (1 − a² b²) − T),
// and, as in the paper, each cos(kΦ) is integrated against the sensors' spectral sensitivities in
// closed form (the series converges fast; three terms here). We model each RGB channel's
// sensitivity as a Gaussian in wavenumber ν = 1/λ (centre ν_c, width σ), for which
//   ∫ cos(2π k OPD ν) g(ν) dν = cos(2π k OPD ν_c) exp(−2π² k² OPD² σ²),
// the same Gaussian-fit-in-Fourier-space idea the paper applies to the CIE XYZ functions. The
// s and p polarizations are averaged.
vec3 filmSensitivity(float opd) {
  const vec3 NU = vec3(1.0 / 600.0, 1.0 / 545.0, 1.0 / 455.0);                 // 1/nm
  const vec3 SIG = vec3(45.0 / 360000.0, 38.0 / 297025.0, 30.0 / 207025.0);   // σλ / λ², 1/nm
  return cos(2.0 * PI * opd * NU) * exp(-2.0 * PI * PI * opd * opd * SIG * SIG);
}

vec3 airy(float a, float b, float opd) {
  float T = 1.0 - a * a;
  float q = T * T * b * b / (1.0 - a * a * b * b);
  vec3 R = vec3(a * a + q);
  float m = 1.0;
  for (int k = 1; k <= 3; k++) {
    m *= -a * b;
    R += 2.0 * m * (q - T) * filmSensitivity(float(k) * opd);
  }
  return R;
}

// Reflectance of the film stack at cos θ1 (from air), film IOR eta2, thickness dnm (nm), base IOR
// eta3 (> eta2 here, so there's no total internal reflection at either interface).
vec3 thinFilm(float cos1, float eta2, float eta3, float dnm) {
  float s1 = 1.0 - cos1 * cos1;
  float cos2 = sqrt(1.0 - s1 / (eta2 * eta2));
  float cos3 = sqrt(1.0 - s1 / (eta3 * eta3));
  float r12s = (cos1 - eta2 * cos2) / (cos1 + eta2 * cos2);
  float r12p = (eta2 * cos1 - cos2) / (eta2 * cos1 + cos2);
  float r23s = (eta2 * cos2 - eta3 * cos3) / (eta2 * cos2 + eta3 * cos3);
  float r23p = (eta3 * cos2 - eta2 * cos3) / (eta3 * cos2 + eta2 * cos3);
  float opd = 2.0 * eta2 * dnm * cos2;
  return clamp(0.5 * (airy(r12s, r23s, opd) + airy(r12p, r23p, opd)), 0.0, 1.0);
}

// ---- Lights ----------------------------------------------------------------------------------
// Karis 2013's windowed inverse-square falloff: 1/d², brought smoothly to 0 at `range`.
float windowFalloff(float d, float range) {
  float x = d / range;
  float w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  return w * w / (d * d + 0.01);
}

// Henyey-Greenstein phase function.
float phaseHG(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
}

// Single scattering of a point light in a homogeneous medium along a view ray (Sun, Ramamoorthi,
// Narasimhan & Nayar, "A Practical Analytic Single Scattering Model for Real Time Rendering",
// SIGGRAPH 2005). For extinction β (= scattering, isotropic phase 1/4π), a light of intensity I
// at perpendicular distance h from the ray, its foot x0 along the ray, and the ray from 0 to t:
//   L = β I e^{−β x0} / (2π h) · [F(β h, ξ1) − F(β h, ξ0)],
//   F(u, v) = ∫_0^v e^{−u tan ξ} dξ,  ξ = π/4 + ½ atan((s − x0) / h)  (s = 0 and t).
// The paper tabulates F; here it is a 3-point Gauss–Legendre quadrature of the smooth integrand
// (no texture). h is clamped to `hmin`, the light's size, so a ray through the light stays finite.
vec3 airlight(vec3 ro, vec3 rd, float t, vec3 lp, vec3 I, float beta, float hmin) {
  vec3 sv = lp - ro;
  float x0 = dot(sv, rd);
  float h = max(length(sv - rd * x0), hmin);
  float xi0 = PI * 0.25 + 0.5 * atan(-x0 / h);
  float xi1 = PI * 0.25 + 0.5 * atan((t - x0) / h);
  float u = beta * h;
  float c = 0.5 * (xi0 + xi1);
  float r = 0.5 * (xi1 - xi0);
  const float GX = 0.7745967;
  float f = (8.0 / 9.0) * exp(-u * tan(c)) +
            (5.0 / 9.0) * (exp(-u * tan(c - GX * r)) + exp(-u * tan(min(c + GX * r, 1.5707))));
  return I * (beta * exp(-beta * x0) / (2.0 * PI * h)) * f * r;
}

// ---- Tone (display-referred colours back to HDR) -----------------------------------------------
// lib/lattice-look.js toneInverse: the HDR value that post.frag's tone curve (Narkowicz's ACES fit
// after TONE_EXPOSURE) maps to y.
const float TONE_EXPOSURE = 0.8; // lib/lattice-look.js EXPOSURE
vec3 toneInverse(vec3 y) {
  vec3 t = clamp(y, 0.0, 1.0);
  vec3 a = 2.43 * t - 2.51;
  vec3 b = 0.59 * t - 0.03;
  vec3 v = (-b - sqrt(b * b - 4.0 * a * 0.14 * t)) / (2.0 * a);
  return v / TONE_EXPOSURE;
}
