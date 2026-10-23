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
