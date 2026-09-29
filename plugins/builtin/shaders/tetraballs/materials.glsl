// Tetraballs surface materials. Each returns premultiplied linear colour and coverage (alpha):
// how much of what's behind (the backdrop, or the desktop when u_bgA = 0) it hides.
// Indices follow MATERIALS in src/lib/tetra-material.js; 7 and 8 (fire, smoke) are volumetric
// and drawn by volume.frag, so shade() returns nothing for them.

// --- 0 chrome: a mirror, with one bounce between the balls ------------------------------------
vec4 matChrome(vec3 p, vec3 n, vec3 rd) {
  vec3 r = reflect(rd, n);
  float c = max(dot(n, -rd), 0.0);
  vec3 f0 = vec3(0.93, 0.94, 0.96);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - c, 5.0);
  vec3 seen = env(r);
  // Reflections of the other balls (the look of chrome metaballs): one short secondary march.
  float t = 0.02;
  for (int i = 0; i < 28; i++) {
    float d = map(p + r * t);
    if (d < 0.002) {
      vec3 q = p + r * t;
      vec3 m = calcNormal(q);
      seen = env(reflect(r, m)) * f0 * 0.9;
      break;
    }
    t += d;
    if (t > 2.0 * u_bound.w) break;
  }
  float ao = ambientOcc(p, n);
  return vec4(seen * F * mix(0.45, 1.0, ao), 1.0);
}

// --- 1 soap bubble: thin-film iridescence -----------------------------------------------------
// A cheap RGB stand-in for Belcour & Barla, "A Practical Extension to Microfacet Theory for the
// Modeling of Varying Iridescence" (SIGGRAPH 2017): two-beam interference with optical path
// difference 2·n·d·cosθt and the half-wave shift at the outer face, averaged over three
// wavelengths per channel in place of their spectral integral. src/lib/tetra-material.js
// thinFilm() mirrors this and is tested. Film thickness is a slow fbm field swirling over time and
// draining downward (thicker at the bottom), so bands of colour flow over the surface.
vec3 thinFilm(float d, float cosI) {
  const float ior = 1.33;
  float sin2 = (1.0 - cosI * cosI) / (ior * ior);
  float opd = 2.0 * ior * d * sqrt(max(0.0, 1.0 - sin2));
  vec3 s = vec3(0.0);
  s += 0.5 - 0.5 * cos(2.0 * PI * opd / vec3(600.0, 510.0, 430.0));
  s += 0.5 - 0.5 * cos(2.0 * PI * opd / vec3(640.0, 540.0, 460.0));
  s += 0.5 - 0.5 * cos(2.0 * PI * opd / vec3(680.0, 570.0, 490.0));
  return s / 3.0;
}

vec4 matSoap(vec3 p, vec3 n, vec3 rd) {
  float c = max(dot(n, -rd), 0.0);
  vec3 q = p * 1.1 + vec3(0.0, u_time * 0.12, u_time * 0.05);
  q += 0.6 * vec3(vnoise(q + 3.1), vnoise(q + 7.7), vnoise(q + 1.3)); // swirl
  float drain = clamp(0.5 - 0.5 * (p.y - u_bound.y) / max(u_bound.w, 0.1), 0.0, 1.0);
  float th = 180.0 + 650.0 * fbm(q) * (0.55 + 0.9 * drain);
  vec3 film = thinFilm(th, c);
  vec3 r = reflect(rd, n);
  float edge = pow(1.0 - c, 2.0);
  vec3 rgb = env(r) * film * (0.22 + 0.78 * edge) + film * 0.03;
  float a = clamp(0.1 + 0.55 * edge, 0.0, 1.0);
  return vec4(rgb, a);
}

// --- 2 jade / wax: subsurface scattering approximation ----------------------------------------
// Translucency from thickness: the interior chord along the view ray gives Beer–Lambert
// transmittance of light from behind ("thin parts glow"), a local thickness probe along −n adds
// wrap-lit forward scattering from the key light, and a thin clear coat reflects the studio.
vec4 matJade(vec3 p, vec3 n, vec3 rd) {
  float c = max(dot(n, -rd), 0.0);
  vec3 tint = u_tint;
  vec3 sigma = (1.0 - tint) * 2.4 + 0.2;          // extinction: the tint's colour gets through
  float chord = marchInside(p - n * 0.003, rd, 2.5 * u_bound.w);
  vec3 back = envDiffuse(rd) * exp(-sigma * chord);
  float local = clamp(-map(p - n * 0.35) / 0.35, 0.0, 1.0); // 0 = thin, 1 = thick
  vec3 lk = normalize(KEY);
  float wrap = max(0.0, (dot(n, lk) + 0.6) / 1.6);
  float through = pow(max(0.0, dot(rd, lk)), 3.0) + 0.35 * pow(max(0.0, -dot(n, lk)), 2.0);
  vec3 body = tint * envDiffuse(n) * 0.16 * (0.45 + 0.55 * wrap);
  vec3 glow = tint * (2.0 * back + 2.2 * through * (1.0 - local)) + tint * 0.9 * pow(1.0 - local, 1.5);
  float ao = ambientOcc(p, n);
  vec3 spec = env(reflect(rd, n)) * schlick(c, 0.045);
  return vec4((body + glow) * mix(0.6, 1.0, ao) + spec, 1.0);
}

// --- 3 brushed metal: anisotropic GGX ---------------------------------------------------------
// Tangent frame from a direction field on the blob: grooves run around the tumble axis (a lathe
// finish), t = normalize(n × axis). Highlights use the anisotropic GGX distribution (Burley 2012,
// "Physically Based Shading at Disney", SIGGRAPH course) with αt ≫ αb; the environment is
// reflected through a fan of directions along the rough axis, which streaks the softboxes.
float ggxAniso(vec3 h, vec3 n, vec3 t, vec3 b, float at, float ab) {
  float x = dot(h, t) / at;
  float y = dot(h, b) / ab;
  float z = dot(h, n);
  float k = x * x + y * y + z * z;
  return 1.0 / (PI * at * ab * k * k);
}

vec4 matBrushed(vec3 p, vec3 n, vec3 rd) {
  vec3 t = cross(n, u_axis);
  t = dot(t, t) < 1e-4 ? normalize(cross(n, vec3(1, 0, 0))) : normalize(t);
  vec3 b = cross(n, t);
  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  vec3 f0 = vec3(0.91, 0.915, 0.92);
  vec3 r = reflect(rd, n);
  vec3 streak = vec3(0.0);
  float ws = 0.0;
  for (int i = -5; i <= 5; i++) {
    float o = float(i) / 5.0;
    float wgt = exp(-2.0 * o * o);
    streak += wgt * envS(normalize(r + t * (o * 0.75)), 0.12);
    ws += wgt;
  }
  streak /= ws;
  vec3 spec = vec3(0.0);
  vec3 lights[3] = vec3[3](normalize(KEY), normalize(FILL), normalize(RIM));
  vec3 lcol[3] = vec3[3](vec3(3.2, 3.0, 2.7), vec3(0.8, 1.0, 1.3), vec3(1.8));
  for (int i = 0; i < 3; i++) {
    vec3 l = lights[i];
    float nl = max(dot(n, l), 0.0);
    vec3 h = normalize(l + v);
    float D = ggxAniso(h, n, t, b, 0.6, 0.035);
    spec += lcol[i] * D * nl / (4.0 * nv * max(nl, 1e-3) + 1e-3) * nl;
  }
  // Fine grooves: a smooth ridge profile across the brushing direction, low contrast.
  float g = vnoise(vec3(dot(p, b) * 70.0, dot(p, t) * 2.0, 0.0));
  float ao = ambientOcc(p, n);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
  vec3 col = (streak * 0.75 + spec * 0.3) * F * (1.0 + 0.3 * (g - 0.5) * nv) * mix(0.5, 1.0, ao);
  return vec4(col, 1.0);
}

// --- 4 velvet: Charlie sheen ------------------------------------------------------------------
// Estevez & Kulla, "Production Friendly Microfacet Sheen BRDF" (SIGGRAPH 2017 Physically Based
// Shading course): D = (2 + 1/α) sin(θh)^(1/α) / 2π, with Neubelt & Pettineo's visibility
// V = 1 / (4 (NoL + NoV − NoL·NoV)). Soft sheen that brightens toward grazing angles and the rim.
float charlieD(float a, float nh) {
  float inv = 1.0 / a;
  float s2 = max(1.0 - nh * nh, 0.0);
  return (2.0 + inv) * pow(s2, inv * 0.5) / (2.0 * PI);
}

vec4 matVelvet(vec3 p, vec3 n, vec3 rd) {
  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  vec3 base = vec3(0.16, 0.012, 0.045);
  vec3 sheen = vec3(1.0, 0.42, 0.58);
  float alpha = 0.35;
  vec3 lights[3] = vec3[3](normalize(KEY), normalize(FILL), normalize(RIM));
  vec3 lcol[3] = vec3[3](vec3(3.0, 2.8, 2.5), vec3(0.9, 1.1, 1.5), vec3(3.0));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 l = lights[i];
    float nl = max(dot(n, l), 0.0);
    vec3 h = normalize(l + v);
    float D = charlieD(alpha, max(dot(n, h), 0.0));
    float V = 1.0 / (4.0 * (nl + nv - nl * nv) + 1e-4);
    col += lcol[i] * nl * (base / PI + sheen * D * V);
  }
  // Ambient: diffuse from the room plus the sheen's grazing lobe lit by the environment.
  float ao = ambientOcc(p, n);
  col += envDiffuse(n) * (base * 0.6 + sheen * 0.18 * pow(1.0 - nv, 3.0)) * ao;
  return vec4(col * mix(0.6, 1.0, ao), 1.0);
}

// --- 5 glass / 6 water: refraction ------------------------------------------------------------
// Fresnel reflection plus refraction through the blob with one exit (total internal reflection
// takes one internal bounce). Glass: chromatic dispersion, a separate IOR per RGB channel. Water:
// IOR 1.33, Beer–Lambert blue absorption by the interior path length, a sharp sun glint, gently
// rippling normals and caustic-like highlights where the exiting light converges toward the key.
vec3 exitDir(vec3 d, vec3 nIn, float eta) {
  vec3 o = refract(d, nIn, eta);
  return dot(o, o) < 1e-6 ? reflect(d, nIn) : o;
}

vec4 matGlass(vec3 p, vec3 n, vec3 rd) {
  float c = max(dot(n, -rd), 0.0);
  float F = schlick(c, 0.045);
  vec3 refl = env(reflect(rd, n));
  const vec3 ior = vec3(1.44, 1.5, 1.58);
  vec3 dg = refract(rd, n, 1.0 / ior.g);
  float L = marchInside(p - n * 0.003, dg, 2.5 * u_bound.w);
  vec3 pe = p + dg * L;
  vec3 ne = -calcNormal(pe); // pointing inward
  vec3 trans;
  trans.r = env(exitDir(refract(rd, n, 1.0 / ior.r), ne, ior.r)).r;
  trans.g = env(exitDir(dg, ne, ior.g)).g;
  trans.b = env(exitDir(refract(rd, n, 1.0 / ior.b), ne, ior.b)).b;
  trans *= vec3(0.96, 0.98, 0.97);
  float see = mix(0.45, 1.0, u_bgA); // over the desktop, part of what's behind shows through
  return vec4(refl * F + trans * (1.0 - F) * see, F + (1.0 - F) * see);
}

vec4 matWater(vec3 p, vec3 n, vec3 rd) {
  vec3 w = p * 3.0 + vec3(0.0, u_time * 0.6, u_time * 0.4);
  n = normalize(n + 0.09 * (vec3(vnoise(w), vnoise(w + 5.2), vnoise(w + 9.7)) - 0.5));
  float c = max(dot(n, -rd), 0.0);
  float F = schlick(c, 0.02);
  vec3 r = reflect(rd, n);
  vec3 lk = normalize(KEY);
  vec3 refl = env(r) + vec3(40.0) * pow(max(dot(r, lk), 0.0), 900.0);
  vec3 d = refract(rd, n, 1.0 / 1.33);
  float L = marchInside(p - n * 0.003, d, 2.5 * u_bound.w);
  vec3 pe = p + d * L;
  vec3 ne = -calcNormal(pe);
  vec3 o = exitDir(d, ne, 1.33);
  vec3 absorb = exp(-L * vec3(0.95, 0.28, 0.1) * 0.9);
  vec3 trans = env(o) * absorb;
  // Caustic-like highlights: light from the key focused through the far wall.
  float caust = pow(max(dot(o, lk), 0.0), 12.0) + 0.6 * pow(max(dot(-ne, lk), 0.0), 24.0);
  trans += vec3(0.8, 0.95, 1.0) * caust * 1.4 * absorb;
  float see = mix(0.4, 1.0, u_bgA);
  vec3 tintSeen = vec3(0.02, 0.08, 0.12) * (1.0 - u_bgA); // keep a hint of blue over the desktop
  return vec4(refl * F + (trans * see + tintSeen) * (1.0 - F), F + (1.0 - F) * see);
}

vec4 shade(int m, vec3 p, vec3 n, vec3 rd) {
  if (m == 0) return matChrome(p, n, rd);
  if (m == 1) return matSoap(p, n, rd);
  if (m == 2) return matJade(p, n, rd);
  if (m == 3) return matBrushed(p, n, rd);
  if (m == 4) return matVelvet(p, n, rd);
  if (m == 5) return matGlass(p, n, rd);
  if (m == 6) return matWater(p, n, rd);
  return vec4(0.0);
}
