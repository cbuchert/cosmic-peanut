// Cinematic look: prefiltered lines (Eric Chan & Frédo Durand, "Fast Prefiltered Lines", GPU Gems 2,
// ch. 22, 2005; src/lib/quads.js). Spliced into the quad-*.vert shaders at their "include quad"
// marker, after their uniforms. Each polyline point arrives twice, once per side; lineVertex moves
// it off the line along the screen-space normal of its neighbours by the core half width plus 2.5
// filter sigmas, and hands the fragment shader its signed distance from the centre line (vDist,
// interpolated like their edge functions). Depth of field (src/lib/dof.js): the thin-lens circle of
// confusion from view depth widens the filter by the blur disk's sigma (diameter / 4), so an
// out-of-focus line is wider and proportionally dimmer, its energy unchanged.
uniform vec2 uViewport;              // target size, pixels
uniform float uHalf, uSigma;         // line core half width and prefilter sigma, pixels
uniform float uFocus, uAperture, uCocMax; // focal distance; blur disk far away and its cap, pixels (0: no DoF)
out float vDist, vHalf, vSigma;

vec2 toScreen(vec4 c) {
  return c.xy / c.w * 0.5 * uViewport;
}

// e: this point in view space; ep / en: its neighbours (e itself at an open end); side: -1 or 1.
vec4 lineVertex(vec4 e, vec4 ep, vec4 en, float side) {
  vec4 c = uProj * e;
  float depth = -e.z;
  float coc = uAperture > 0.0 ? min(uCocMax, uAperture * abs(1.0 - uFocus / max(depth, 1e-6))) : 0.0;
  float sigma = sqrt(uSigma * uSigma + coc * coc / 16.0);
  float ext = uHalf + 2.5 * sigma;
  vHalf = uHalf;
  vSigma = sigma;
  vDist = side * ext;
  if (c.w < 1e-4) return c;                                // behind the eye: clipping takes it
  vec4 cp = uProj * ep;
  vec4 cn = uProj * en;
  vec2 s = toScreen(c);
  vec2 sp = cp.w > 1e-4 ? toScreen(cp) : s;
  vec2 sn = cn.w > 1e-4 ? toScreen(cn) : s;
  vec2 t = sn - sp;
  float len = length(t);
  t = len > 1e-6 ? t / len : vec2(1.0, 0.0);
  c.xy += vec2(-t.y, t.x) * (side * ext * 2.0 * c.w) / uViewport;
  return c;
}
