// Lattice family — shading: light, materials, emission (history, running light, pulses), AO
// and fog. Structure-agnostic: it reads the hit only through the structure's structKind,
// structAxis, structNodeFace, structStrut, pulseMetric and sceneSDF.
//
// Light: a headlight at the camera and a fixed key light (wrapped diffuse + soft specular),
// ambient occlusion from STRUCT_AO_SAMPLES SDF samples, then exponential fog to the background
// (or to transparent). On paper (u_ink) light can't add, so emission mixes toward its colour.
// MATERIALS (Tentacle Lattice): Tentacube's four materials crossfaded by u_mat.
// Output: linear, premultiplied RGBA (post.frag converts to sRGB).

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
