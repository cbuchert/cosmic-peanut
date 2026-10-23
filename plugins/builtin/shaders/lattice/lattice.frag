#version 300 es
// Lattice raymarch (reduced resolution): an endless cubic lattice by domain repetition. Nodes sit
// at integer points (a rounded cube each), rods run along the three axes between them. All
// positions are relative to an integer origin near the camera (u_cam is the camera's offset from
// it), so precision never degrades however far the flight goes.
//
// Light: a headlight at the camera and a fixed key light (wrapped diffuse + soft specular),
// ambient occlusion from five SDF samples, then exponential fog to the background (or to
// transparent). Emission: the rods' running light per axis (x bass, y mids, z treble), the beat
// pulses (lib/lattice-pulses.js: L1 distance along the rods from each pulse's node to its front),
// and the cube faces' scrolling spectrogram / waveform history. On paper (u_ink) light can't add,
// so emission mixes toward its colour instead.
//
// Output: linear, premultiplied RGBA (the composite pass converts to sRGB).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec2 u_res;
uniform vec3 u_cam;
uniform vec3 u_fwd;
uniform vec3 u_up;
uniform vec3 u_right;
uniform float u_tanHalf;
uniform vec3 u_geo;      // rod radius, cube half-size, cube rounding
uniform float u_fog;     // density per cell
uniform float u_far;     // march limit, cells
uniform int u_steps;
uniform vec3 u_bg;
uniform vec3 u_surf;
uniform vec3 u_ax;       // x-axis colour (bass)
uniform vec3 u_ay;       // y (mids)
uniform vec3 u_az;       // z (treble)
uniform vec3 u_glow;     // beat-pulse colour
uniform float u_ink;     // 1: draw light as ink
uniform float u_bgA;     // 1: fog to the background colour, 0: to transparent
uniform vec3 u_light;    // x, y, z axis light (lib/lattice.js createAxisLight)
uniform float u_time;    // the rods' running-light clock
uniform vec4 u_pulse[8]; // lib/lattice-pulses.js PULSE_CAP; node xyz (relative to the origin), front distance (cells)
uniform float u_pamp[8];
uniform sampler2D u_hist; // W bands × N rows: R spectrum level, G waveform (0.5 = 0)
uniform float u_head;
uniform float u_rows;

const float FACE_ROWS = 40.0;  // history rows across one cube face
const float NODE_ROWS = 7.0;   // extra rows of age per cell (L1) from the camera's node
const float PULSE_W = 0.32;    // half-width of a pulse front, cells

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Distance to the lattice; `id` = 0 cube, 1 x-rod, 2 y-rod, 3 z-rod.
float map(vec3 p, out int id) {
  vec3 q = p - floor(p + 0.5);
  float r = u_geo.x;
  float dc = sdRoundBox(q, vec3(u_geo.y - u_geo.z), u_geo.z);
  float dx = length(q.yz) - r;
  float dy = length(q.xz) - r;
  float dz = length(q.xy) - r;
  float d = dc;
  id = 0;
  if (dx < d) { d = dx; id = 1; }
  if (dy < d) { d = dy; id = 2; }
  if (dz < d) { d = dz; id = 3; }
  return d;
}

float map(vec3 p) {
  int id;
  return map(p, id);
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0015;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                   k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 1; i <= 5; i++) {
    float h = 0.02 + 0.06 * float(i);
    occ += (h - map(p + n * h)) * w;
    w *= 0.7;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

// Beat pulses at a point on the rod network (`pr`: node coordinates, with the rod's own axis
// replaced by the hit's position along it).
float pulses(vec3 pr) {
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = u_pamp[i];
    if (a <= 0.0) continue;
    vec3 d = abs(pr - u_pulse[i].xyz);
    float l1 = d.x + d.y + d.z;
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

void main() {
  vec2 uv = (gl_FragCoord.xy / u_res) * 2.0 - 1.0;
  float aspect = u_res.x / u_res.y;
  vec3 rd = normalize(u_fwd + uv.x * aspect * u_tanHalf * u_right + uv.y * u_tanHalf * u_up);
  vec3 ro = u_cam;

  float t = 0.02;
  int id = 0;
  bool hit = false;
  for (int i = 0; i < 160; i++) {
    if (i >= u_steps) break;
    float d = map(ro + rd * t, id);
    if (d < 0.0008 + 0.0015 * t) { hit = true; break; }
    t += d;
    if (t > u_far) break;
  }

  // Ran out of distance or steps: all fog (u_far sits where the fog is nearly opaque anyway).
  if (!hit) {
    o = vec4(u_bg * u_bgA, u_bgA);
    return;
  }
  float fogT = exp(-t * u_fog);

  vec3 p = ro + rd * t;
  vec3 n = calcNormal(p);
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  float ao = ambientOcclusion(p, n);

  // Albedo: the rods carry a little of their axis colour.
  vec3 axisCol = id == 1 ? u_ax : id == 2 ? u_ay : u_az;
  float axisLight = id == 1 ? u_light.x : id == 2 ? u_light.y : u_light.z;
  vec3 albedo = id == 0 ? u_surf : mix(u_surf, axisCol, 0.18 * (1.0 - u_ink));

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

  // Emission.
  vec3 e = vec3(0.0);
  if (id == 0) {
    // Cube faces: the history scrolls across each face; faces facing y show the waveform,
    // the others the spectrogram. Farther cubes show older rows, so the music ripples outward.
    vec3 an = abs(n);
    vec2 f;
    float wave = 0.0;
    if (an.x > an.y && an.x > an.z) f = q.zy;
    else if (an.y > an.z) { f = q.xz; wave = 1.0; }
    else f = q.xy;
    f /= u_geo.y;
    vec3 dn = abs(node - floor(u_cam + 0.5));
    float age = (0.5 - 0.5 * f.y) * FACE_ROWS + (dn.x + dn.y + dn.z) * NODE_ROWS;
    float band = clamp(0.5 + 0.5 * f.x, 0.0, 1.0);
    vec4 h = hist(band, age);
    float inside = smoothstep(1.0, 0.82, max(abs(f.x), abs(f.y)));
    float level = mix(h.r * h.r * 1.4, abs(h.g - 0.5) * 2.4, wave);
    vec3 tint = band < 0.5 ? mix(u_ax, u_ay, band * 2.0) : mix(u_ay, u_az, band * 2.0 - 1.0);
    e += tint * level * inside * (0.45 - 0.25 * u_ink);
    // A node lights as a pulse front passes through it.
    e += u_glow * pulses(node) * 1.5;
  } else {
    // Rods: a running light flowing away from each node, brighter with the axis's band energy.
    float along = id == 1 ? q.x : id == 2 ? q.y : q.z;
    float u = abs(along); // 0 at a node, 0.5 midway
    float run = pow(0.5 + 0.5 * cos(6.2831853 * (u * 2.0 - u_time * 0.6)), 10.0);
    e += axisCol * axisLight * (0.03 + 0.9 * run);
    vec3 pr = node;
    if (id == 1) pr.x = p.x;
    else if (id == 2) pr.y = p.y;
    else pr.z = p.z;
    e += u_glow * pulses(pr) * 2.0;
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
  o = u_bgA > 0.5 ? vec4(fogged, 1.0) : vec4(col * fogT, fogT);
}
