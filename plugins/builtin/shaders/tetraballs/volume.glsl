// Tetraballs volume pass (reduced resolution, then upscaled by composite.frag): fire and smoke
// as density fields grown off the blob. Fixed step count and offsets (no per-pixel jitter, so no
// grain); the density is smooth fbm advected upward in time.
//
// Fire: heat is 1 inside the blob and falls off with distance to a noise-displaced surface whose
// displacement grows with height, so tongues of flame lick upward off the balls and flicker. The
// emission colour is a blackbody ramp (Planck's law sampled at three wavelengths, normalised),
// accumulated additively with light absorption. Smoke: billowing fbm density pushed off the balls
// and drifting up into wisps, single-scattered key light with self-shadowing from a short
// light march (3 steps, cheaper two-octave density), plus ambient light from the room.
uniform vec4 u_vbound;     // march volume: centre xyz, radius w (the blob's bound, raised)
uniform float u_fire;      // weight of fire in this pass
uniform float u_smoke;     // weight of smoke
uniform int u_vsteps;      // samples along each ray

out vec4 o;

// Blackbody colour for temperature T (kelvin), Planck's law at 610/550/465 nm, normalised so the
// brightest channel is 1.
vec3 blackbody(float T) {
  vec3 lam = vec3(0.61, 0.55, 0.465); // micrometres
  vec3 b = 1.0 / (pow(lam, vec3(5.0)) * (exp(14388.0 / (lam * T)) - 1.0)); // c2 = hc/k, µm·K
  return b / max(b.r, max(b.g, b.b));
}

// How far above the blob's centre p sits, in blob radii (flames and smoke grow with height).
float upness(vec3 p) {
  return clamp((p.y - u_bound.y) / max(u_bound.w, 0.2) + 0.55, 0.0, 2.0);
}

// Fire: returns heat (density driver) in x and temperature 0–1 in y. The blob is stretched
// upward into a teardrop (heights above the centroid are squashed before the SDF lookup, and the
// top is narrowed), then eroded and extended by rising noise that grows with height, so the
// flames lick upward off the balls in separate tongues.
vec2 fire(vec3 p) {
  float R = max(u_bound.w, 0.2);
  float hy = p.y - u_bound.y;
  float top = max(hy, 0.0) / R;
  if (hy > 1.6 * R) return vec2(0.0);
  float squash = 1.0 / (1.0 + 1.1 * top * u_light);
  vec3 q = vec3(p.x * (1.0 + 0.5 * top), u_bound.y + hy * squash, p.z * (1.0 + 0.5 * top));
  float d = map(q);
  float amp = 0.1 + 0.32 * top;
  if (d > amp + 0.1) return vec2(0.0);
  vec3 w = vec3(p.x * 2.6, p.y * 1.3 - u_time * 2.6, p.z * 2.6);
  w.xz += 0.5 * vec2(vnoise(w * 0.5 + 4.0), vnoise(w * 0.5 + 9.0)) - 0.25; // sway
  float n = fbm(w);
  float de = d - amp * (n - 0.42) * 2.4;
  // Flames are thin reaction sheets: heat lives in a shell around the displaced surface, and the
  // shell's folds give the fire its streaky inner structure.
  float heat = smoothstep(0.14, 0.0, de) * smoothstep(-0.42, -0.03, de);
  float temp = heat * (1.0 - 0.6 * clamp(top / 1.3, 0.0, 1.0)) * clamp(0.25 + 1.0 * n * n + 0.25 * n, 0.0, 1.0);
  // Fade out before the top of the frame (y ≈ 2.1 at the centroid plane).
  return vec2(heat, temp) * smoothstep(1.6 * R, 0.5 * R, hy) * smoothstep(2.0, 1.3, p.y);
}

float smokeDensity(vec3 p, float d) {
  float up = upness(p);
  float reach = 0.08 + 0.3 * up;
  float wispLen = min(0.4 * up * up, 0.9);
  if (d > max(reach, wispLen) + 0.15) return 0.0;
  vec3 q = p * 1.35 + vec3(0.0, -u_time * 0.32, 0.0);
  q += 0.55 * vec3(vnoise(q * 0.8 + 2.0), vnoise(q * 0.8 + 6.0), vnoise(q * 0.8 + 11.0));
  float n = fbm(q);
  // Billows hugging the balls ...
  float de = d - reach * n * n * 1.8;
  float body = smoothstep(0.06, -0.2, de) * (0.25 + 0.9 * n) * smoothstep(-0.9, -0.1, d - reach);
  // ... and thin wisps rising off the top, stretched upward and drifting faster.
  float wisp = 0.0;
  if (d > 0.0 && d < wispLen + 0.1) {
    vec3 w = vec3(p.x * 3.2, p.y * 1.1 - u_time * 0.7, p.z * 3.2) + 0.8 * vec3(n, 0.0, n);
    wisp = smoothstep(0.6, 0.75, fbm(w)) * smoothstep(wispLen + 0.1, 0.0, d);
  }
  float top = u_bound.w * 2.4;
  return (body + 0.55 * wisp) * smoothstep(top, top * 0.3, p.y - u_bound.y);
}

// Cheaper smoke density for the light march (self-shadowing): the billows only, two octaves.
float smokeShade(vec3 p) {
  float d = map(p);
  float reach = 0.08 + 0.3 * upness(p);
  if (d > reach + 0.1) return 0.0;
  vec3 q = p * 1.35 + vec3(0.0, -u_time * 0.32, 0.0);
  float n = 0.667 * vnoise(q) + 0.333 * vnoise(q * 2.03 + 1.7);
  return smoothstep(0.06, -0.2, d - reach * n * n * 1.8) * (0.25 + 0.9 * n);
}

void main() {
  vec3 ro = vec3(0.0, 0.0, CAM);
  vec3 rd = rayDir(gl_FragCoord.xy);
  vec2 tb = sphereHit(ro, rd, u_vbound);
  if (tb.x >= tb.y) {
    o = vec4(0.0);
    return;
  }
  float t0 = max(tb.x, 0.0);
  float dt = (tb.y - t0) / float(u_vsteps);
  float t = t0 + 0.5 * dt;
  vec3 emit = vec3(0.0);
  vec3 scat = vec3(0.0);
  float trans = 1.0;
  vec3 lk = normalize(KEY);
  vec3 amb = envDiffuse(vec3(0.0, 1.0, 0.0)) * 0.12;
  for (int i = 0; i < 128; i++) {
    if (i >= u_vsteps || trans < 0.01) break;
    vec3 p = ro + rd * t;
    if (u_fire > 0.0) {
      vec2 f = fire(p);
      if (f.x > 0.0) {
        float K = 800.0 + 2400.0 * pow(f.y, 1.4);
        float dens = f.x * f.x * 6.0;
        emit += trans * blackbody(K) * pow(f.y, 2.2) * dens * dt * 1.05 * u_fire * u_light;
        trans *= exp(-dens * dt * 0.45 * u_fire);
      }
    }
    if (u_smoke > 0.0) {
      float dens = smokeDensity(p, map(p)) * 5.0 * u_smoke;
      if (dens > 0.001) {
        float sh = 0.0;
        for (int j = 1; j <= 3; j++) sh += smokeShade(p + lk * (0.2 * float(j)));
        float lit = exp(-sh * 0.2 * 5.0 * 2.2);
        vec3 light = vec3(3.4, 3.15, 2.85) * lit * u_light + amb;
        float a = 1.0 - exp(-dens * dt);
        scat += trans * a * light * vec3(0.55, 0.55, 0.57);
        trans *= 1.0 - a;
      }
    }
    t += dt;
  }
  float a = 1.0 - trans;
  vec3 s = a > 1e-4 ? tonemap(scat / a) * a : vec3(0.0);
  vec3 e = tonemap(emit);
  vec3 rgb = s * (1.0 - e) + e;
  o = vec4(rgb, clamp(max(a * (1.0 - u_fire * 0.6), max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0));
}
