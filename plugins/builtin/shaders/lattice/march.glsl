// Lattice family — the sphere tracer and surface normal, over the structure's sceneSDF.

float sceneSDF(vec3 p) {
  int id;
  return sceneSDF(p, id);
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0015;
  return normalize(k.xyy * sceneSDF(p + k.xyy * h) + k.yyx * sceneSDF(p + k.yyx * h) +
                   k.yxy * sceneSDF(p + k.yxy * h) + k.xxx * sceneSDF(p + k.xxx * h));
}

#ifdef CINEMATIC
// The cinematic look replaces march() with the over-relaxed tracer at the end of this file; the
// plain one below is kept, renamed.
#define march marchPlain
#endif

// March from `ro` along `rd` (unit): at most u_steps steps (capped by STRUCT_MAX_STEPS), each
// structStep(d), until within a pixel-ish distance of the surface (true: `t`, `id` at the hit)
// or past u_far (false).
bool march(vec3 ro, vec3 rd, out float t, out int id) {
  t = 0.02;
  id = 0;
  for (int i = 0; i < STRUCT_MAX_STEPS; i++) {
    if (i >= u_steps) break;
    float d = sceneSDF(ro + rd * t, id);
    if (d < 0.0008 + 0.0015 * t) return true;
    t += structStep(d);
    if (t > u_far) break;
  }
  return false;
}

#ifdef CINEMATIC
#undef march
// Over-relaxed sphere tracing (Keinert, Schäfer, Korndörfer, Ganse & Stamminger, "Enhanced Sphere
// Tracing", STAG 2014): step ω × the structure's safe step (structStep), ω = MARCH_OMEGA > 1.
// A relaxed step is accepted only if the unbounding sphere at the new point overlaps the one at
// the previous point (r_prev + r ≥ step) and the point is outside; their union then covers the
// segment between them, so no surface was skipped and structStep's guarantee still holds. On
// overshoot it steps back to the plain step from the previous point (r_prev) and takes the next
// step plain. Near surfaces (d < MARCH_RELAX_MIN) it steps plain, where relaxing only overshoots.
// Same signature, budget, hit test and limit as the plain tracer.
const float MARCH_OMEGA = 1.4;
const float MARCH_RELAX_MIN = 0.03;
bool march(vec3 ro, vec3 rd, out float t, out int id) {
  t = 0.02;
  id = 0;
  float tPrev = t;
  float rPrev = 0.0;
  bool relaxed = false; // whether the step that brought us here was over-relaxed
  for (int i = 0; i < STRUCT_MAX_STEPS; i++) {
    if (i >= u_steps) break;
    float d = sceneSDF(ro + rd * t, id);
    if (relaxed && (d < 0.0 || structStep(d) + rPrev < t - tPrev)) {
      t = tPrev + rPrev; // overshoot: back to the plain step
      relaxed = false;
      continue;
    }
    if (d < 0.0008 + 0.0015 * t) return true;
    float r = structStep(d);
    relaxed = d > MARCH_RELAX_MIN;
    tPrev = t;
    rPrev = r;
    t += relaxed ? r * MARCH_OMEGA : r;
    if (t > u_far) break;
  }
  return false;
}
#endif
