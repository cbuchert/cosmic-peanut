// Tetraballs, shared chunk: uniforms, the blob SDF, the procedural studio environment, smooth
// noise, tone mapping. Concatenated after the #version line by src/tetraballs.js.
//
// The blob: four spheres at the corners of a tumbling tetrahedron, fused by a polynomial smooth
// minimum (src/lib/metaball.js mirrors map() and the bounds and is tested there). Rays are only
// marched inside the bounding sphere u_bound, so empty screen costs one ray-sphere test.
precision highp float;
precision highp int;

uniform vec2 u_res;        // pass resolution, pixels
uniform vec4 u_ball[4];    // world centre xyz, radius w
uniform float u_k;         // smooth-min blend width (world units)
uniform vec4 u_bound;      // bounding sphere of the blob: centre xyz, radius w
uniform int u_steps;       // raymarch step budget (Quality)
uniform float u_time;      // seconds, for animated fields
uniform float u_bgA;       // 1 = studio backdrop, 0 = transparent (the desktop shows through)
uniform float u_light;     // flash-limited light level (lib/tetra-material.js createIntensity)
uniform vec3 u_axis;       // tumble frame's "up": brushing direction field of the brushed metal
uniform vec3 u_tint;       // jade / wax body colour (linear)
uniform float u_fade;      // weight of this pass in a surface <-> volume crossfade

const float CAM = 5.0;     // camera distance on +z, looking at the origin
const float TANF = 0.42;   // tan(half vertical field of view)
const float PI = 3.14159265;

const vec3 KEY = vec3(0.54, 0.72, 0.44);   // normalised below: key softbox, above front right
const vec3 FILL = vec3(-0.93, 0.17, 0.32); // tall strip, left
const vec3 RIM = vec3(-0.18, 0.46, -0.87); // back light

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

vec3 rayDir(vec2 frag) {
  vec2 p = (frag - 0.5 * u_res) / (0.5 * u_res.y);
  return normalize(vec3(p * TANF, -1.0));
}

// Entry and exit distances of the ray through a sphere; x > y when it misses.
vec2 sphereHit(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// ---------------------------------------------------------------------------------------------
// The blob
// ---------------------------------------------------------------------------------------------

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float map(vec3 p) {
  float d = length(p - u_ball[0].xyz) - u_ball[0].w;
  d = smin(d, length(p - u_ball[1].xyz) - u_ball[1].w, u_k);
  d = smin(d, length(p - u_ball[2].xyz) - u_ball[2].w, u_k);
  d = smin(d, length(p - u_ball[3].xyz) - u_ball[3].w, u_k);
  return d;
}

// Tetrahedral finite-difference normal (4 map() calls).
vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) +
                   e.xxx * map(p + e.xxx));
}

// Sphere-trace from t0 to t1; returns the hit distance or -1.
float march(vec3 ro, vec3 rd, float t0, float t1) {
  float t = max(t0, 0.0);
  for (int i = 0; i < 160; i++) {
    if (i >= u_steps) break;
    float d = map(ro + rd * t);
    if (d < 0.0006 * t) return t;
    t += d;
    if (t > t1) break;
  }
  return -1.0;
}

// Distance travelled inside the blob from p (just inside the surface) along rd, to the exit.
float marchInside(vec3 p, vec3 rd, float tmax) {
  float t = 0.004;
  for (int i = 0; i < 40; i++) {
    if (i * 2 >= u_steps) break;
    float d = -map(p + rd * t);
    if (d < 0.001) break;
    t += d;
    if (t > tmax) break;
  }
  return t;
}

// Cheap ambient occlusion from the distance field.
float ambientOcc(vec3 p, vec3 n) {
  float o = 0.0;
  float w = 1.0;
  for (int i = 1; i <= 4; i++) {
    float h = 0.06 * float(i);
    o += (h - map(p + n * h)) * w;
    w *= 0.6;
  }
  return clamp(1.0 - 2.2 * o, 0.0, 1.0);
}

// ---------------------------------------------------------------------------------------------
// Studio environment (world space, so reflections stay put while the blob tumbles). HDR.
// ---------------------------------------------------------------------------------------------

// A soft-edged rectangle light centred on direction c, spanned by u and v (tangent half-sizes).
float softbox(vec3 d, vec3 c, vec3 up, vec2 halfSize, float soft) {
  float k = dot(d, c);
  if (k <= 0.0) return 0.0;
  vec3 u = normalize(cross(up, c));
  vec3 v = cross(c, u);
  vec3 q = d / k;
  vec2 xy = abs(vec2(dot(q, u), dot(q, v)));
  vec2 m = smoothstep(halfSize + soft, halfSize - soft, xy);
  return m.x * m.y;
}

// The room without its lights: a dark floor, a bright horizon band, a dim blue-grey dome.
vec3 room(vec3 d) {
  float y = d.y;
  vec3 floorC = mix(vec3(0.16, 0.155, 0.15), vec3(0.03, 0.03, 0.035), smoothstep(0.0, 0.6, -y));
  vec3 dome = mix(vec3(0.34, 0.36, 0.42), vec3(0.05, 0.06, 0.09), smoothstep(0.0, 0.8, y));
  vec3 c = y < 0.0 ? floorC : dome;
  c += vec3(0.5, 0.52, 0.55) * exp(-60.0 * y * y) * 0.6; // horizon glow
  return c;
}

// The studio: room + softboxes. `soft` widens every light's edge (a cheap stand-in for a
// pre-filtered, rougher lookup; 0 = the sharp mirror image).
vec3 envS(vec3 d, float soft) {
  vec3 c = room(d);
  c += vec3(6.0, 5.6, 5.0) * softbox(d, normalize(KEY), vec3(0, 1, 0), vec2(0.55, 0.35), 0.08 + soft);
  c += vec3(1.6, 2.0, 2.6) * softbox(d, normalize(FILL), vec3(0, 1, 0), vec2(0.12, 0.95), 0.05 + soft);
  c += vec3(4.2, 4.2, 4.4) * softbox(d, normalize(RIM), vec3(0, 1, 0), vec2(0.9, 0.08), 0.04 + soft);
  // Two thin overhead strips: long streaks on anything shiny.
  c += vec3(2.5) * softbox(d, vec3(0, 1, 0), vec3(0, 0, 1), vec2(0.03, 2.0), 0.02 + soft) * step(0.0, d.y);
  c += vec3(2.0) * softbox(d, normalize(vec3(0.0, 0.8, -0.6)), vec3(1, 0, 0), vec2(1.8, 0.025), 0.015 + soft);
  return c;
}

vec3 env(vec3 d) { return envS(d, 0.0); }

// Blurry environment for diffuse/rough lobes: the room plus the lights as broad lobes.
vec3 envDiffuse(vec3 n) {
  vec3 c = room(n) * 0.8 + vec3(0.06);
  c += vec3(1.3, 1.22, 1.1) * pow(max(dot(n, normalize(KEY)), 0.0), 1.5);
  c += vec3(0.28, 0.36, 0.46) * pow(max(dot(n, normalize(FILL)), 0.0), 2.0);
  c += vec3(0.55) * pow(max(dot(n, normalize(RIM)), 0.0), 2.0);
  return c;
}

// What's behind the blob with the studio backdrop on: a soft vignetted cyclorama.
vec3 backdrop(vec2 frag) {
  vec2 p = (frag - 0.5 * u_res) / u_res.y;
  float r = length(p * vec2(0.8, 1.0));
  vec3 c = mix(vec3(0.045, 0.047, 0.056), vec3(0.006, 0.006, 0.009), smoothstep(0.0, 0.9, r));
  c += vec3(0.012, 0.011, 0.01) * smoothstep(0.1, -0.35, p.y); // floor bounce
  return c;
}

float schlick(float cosT, float f0) {
  float m = clamp(1.0 - cosT, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}

// ---------------------------------------------------------------------------------------------
// Smooth noise (no grain: value noise with quintic interpolation of an integer hash)
// ---------------------------------------------------------------------------------------------

float hash3(ivec3 q) {
  uvec3 u = uvec3(q) * uvec3(1597334673u, 3812015801u, 2798796415u);
  uint n = (u.x ^ u.y ^ u.z) * 1597334673u;
  return float(n >> 8) * (1.0 / 16777216.0);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec3 b = ivec3(i);
  float a000 = hash3(b), a100 = hash3(b + ivec3(1, 0, 0));
  float a010 = hash3(b + ivec3(0, 1, 0)), a110 = hash3(b + ivec3(1, 1, 0));
  float a001 = hash3(b + ivec3(0, 0, 1)), a101 = hash3(b + ivec3(1, 0, 1));
  float a011 = hash3(b + ivec3(0, 1, 1)), a111 = hash3(b + ivec3(1, 1, 1));
  return mix(mix(mix(a000, a100, w.x), mix(a010, a110, w.x), w.y),
             mix(mix(a001, a101, w.x), mix(a011, a111, w.x), w.y), w.z);
}

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.9375;
}

// Narkowicz's ACES fit, then sRGB-ish gamma.
vec3 tonemap(vec3 x) {
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2));
}
