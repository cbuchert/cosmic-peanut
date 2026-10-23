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
//
// TENTACLE (defined by src/lattice.js for Tentacle Lattice): the rods become a Tentacube-style
// creature at every node — a rounded cube with six tapered, swaying tentacles reaching toward
// its neighbours (lib/tentacle-lattice.js holds the tested shapes this mirrors: tubeRadius,
// strutDistance, handshake, handshakeReach, swellWeight). Beat pulses make the tentacles they
// pass reach and touch tips; the pulse's node twists a quarter turn; materials crossfade.
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
#ifdef TENTACLE
uniform vec4 u_tg;        // tentacle reach, root radius, tip radius, cube half-size
uniform vec3 u_sway;      // sway amplitude (cells at the tip), wave clock, ripple 0–1
uniform float u_env;      // worst-case tentacle extent from its strut's axis (cells)
uniform float u_swell;    // bass swell (× cube size) at the camera
uniform vec4 u_twist[4];  // lib/tentacle-lattice.js TWIST_CAP; node xyz, angle (rad)
uniform float u_taxis[4]; // twist axis: 0 x, 1 y, 2 z
uniform vec4 u_mat;       // chrome, iridescent, emissive, obsidian weights
uniform vec3 u_origin;    // the integer origin (absolute cells), for per-tentacle hashes
uniform float u_shake;    // handshake scale (lib/lattice.js motionScale: Reduce motion damps it)
uniform vec4 u_live[8];   // the live pulses packed first (lib/lattice-pulses.js live / liveCount)
uniform float u_liveAmp[8];
uniform int u_np;
#endif

const float FACE_ROWS = 40.0;  // history rows across one cube face
const float NODE_ROWS = 7.0;   // extra rows of age per cell (L1) from the camera's node
const float PULSE_W = 0.32;    // half-width of a pulse front, cells
#ifdef TENTACLE
const float PROXY_NEAR = 0.03; // within this of the bound, evaluate the bent tentacles exactly
#endif

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

#ifndef TENTACLE
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
#else
// lib/tentacle-lattice.js tubeRadius: tapered, flared ×1.35 at the root.
float tubeRadius(float s) {
  float t2 = (1.0 - s) * (1.0 - s);
  float t4 = t2 * t2;
  return mix(u_tg.y, u_tg.z, s) * (1.0 + 0.35 * t4 * t4 * t4);
}

// lib/tentacle-lattice.js handshake: ease in, hold, ease out in the front's lead (cells).
float handshake(float lead) {
  if (lead <= -0.35 || lead >= 1.2) return 0.0;
  if (lead < 0.1) return smoothstep(-0.35, 0.1, lead);
  if (lead < 0.35) return 1.0;
  return 1.0 - smoothstep(0.35, 1.2, lead);
}

// How far the strut leaving node `a` along `axis` is reaching (sum over the beat pulses).
float strutShake(vec3 a, int axis) {
  vec3 mid = a;
  mid[axis] += 0.5;
  float h = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_np) break;
    vec3 d = abs(mid - u_live[i].xyz);
    h += u_liveAmp[i] * handshake(u_live[i].w - (d.x + d.y + d.z));
  }
  return clamp(h * u_shake, 0.0, 1.0);
}

uint hash3(uvec3 v) {
  uint h = v.x * 1664525u + v.y * 22695477u + v.z * 2891336453u + 1013904223u;
  h ^= h >> 16u;
  h *= 2246822519u;
  h ^= h >> 13u;
  h *= 3266489917u;
  h ^= h >> 16u;
  return h;
}

// One tentacle rooted at `root` (relative to the origin), growing along `axis` in direction
// `dir` (±1); `along` is the point's distance from the root along the axis, `w` its offset
// across. Sways by up to amp × s^1.5 (lib/tentacle-lattice.js envelope), in a hashed direction
// and phase, as a wave running root → tip; reaches (and straightens) with the handshake.
float tentacle(vec3 root, int axis, float dir, float along, vec2 w, float shake) {
  uvec3 key = uvec3(ivec3(root + u_origin) + 4096);
  uint h = hash3(key + uvec3(uint(axis) * 7u + (dir > 0.0 ? 3u : 0u)));
  float ph = float(h & 1023u) / 1023.0;
  vec2 dir2 = normalize(vec2(float((h >> 10u) & 255u), float((h >> 18u) & 255u)) - 127.25);
  float reach = u_tg.x + shake * (0.5 - u_tg.z - u_tg.x);
  float s = clamp(along / reach, 0.0, 1.0);
  float wave = sin(6.2831853 * (u_sway.y * 0.8 + ph) - (2.6 + 2.0 * u_sway.z) * s);
  vec2 off = (u_sway.x * (1.0 - shake) * s * sqrt(s) * wave) * dir2;
  float da = along - s * reach;
  return sqrt(da * da + dot(w - off, w - off)) - tubeRadius(s);
}

// The tentacles on the nearest line of struts along `axis`: the nearest node's two (+ and −) and
// the neighbour's reaching back into this half-cell. Every other tentacle on this line stays
// ≥ 0.45 cell away, and every tentacle of the line lies within u_env of its axis, so the caller
// can skip the whole line while it's farther than the best distance so far (`best`).
float struts(vec3 p, vec3 node, int axis, float best) {
  int a1 = axis == 0 ? 1 : 0;
  int a2 = axis == 2 ? 1 : 2;
  vec2 w = vec2(p[a1] - node[a1], p[a2] - node[a2]);
  // Other lines of this family are ≥ 1 − max|w| away, less their tentacles' reach.
  float other = 1.0 - max(abs(w.x), abs(w.y)) - u_env;
  if (length(w) - u_env >= best) return other;
  float u = p[axis] - node[axis];
  float sg = u >= 0.0 ? 1.0 : -1.0;
  // This half-cell's strut: the node's tentacle on this side and the neighbour's reaching back.
  vec3 st = node;
  if (sg < 0.0) st[axis] -= 1.0;
  float shake = strutShake(st, axis);
  vec3 nb = node;
  nb[axis] += sg;
  float d = min(tentacle(node, axis, sg, abs(u), w, shake), tentacle(nb, axis, -sg, 1.0 - abs(u), w, shake));
  // The node's tentacle on the other side lies beyond the node (its root sways ≤ 0.02 there).
  float r0 = 1.35 * u_tg.y;
  d = min(d, max(abs(u) - r0, length(w) - r0 - 0.02));
  return min(d, other);
}

// Distance to the creature lattice; `id` = 0 cube, 1/2/3 the x/y/z tentacles.
float map(vec3 p, out int id) {
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  // The nodes nearest the camera swell (lib/tentacle-lattice.js swellWeight).
  vec3 dc3 = node - u_cam;
  float half_ = u_tg.w * (1.0 + u_swell * exp(-0.9 * dot(dc3, dc3)));
  // Cheap, exact bound first: every tentacle lies within u_env of its strut's axis and every
  // cube (twisted or not) within its bounding sphere. Far from both, that's the step.
  id = 0;
  float proxy = min(length(q) - 1.75 * half_,
                    min(length(q.yz), min(length(q.xz), length(q.xy))) - u_env);
  if (proxy > PROXY_NEAR) return proxy;
  // A twisting node turns its cube about one axis.
  for (int i = 0; i < 4; i++) {
    float ang = u_twist[i].w;
    if (ang == 0.0 || any(notEqual(node, u_twist[i].xyz))) continue;
    float c = cos(ang);
    float sn = sin(ang);
    int ax = int(u_taxis[i]);
    if (ax == 0) q.yz = mat2(c, sn, -sn, c) * q.yz;
    else if (ax == 1) q.xz = mat2(c, sn, -sn, c) * q.xz;
    else q.xy = mat2(c, sn, -sn, c) * q.xy;
  }
  float rr = 0.35 * half_;
  float d = sdRoundBox(q, vec3(half_ - rr), rr);
  float dx = struts(p, node, 0, d);
  if (dx < d) { d = dx; id = 1; }
  float dy = struts(p, node, 1, d);
  if (dy < d) { d = dy; id = 2; }
  float dz = struts(p, node, 2, d);
  if (dz < d) { d = dz; id = 3; }
  return d;
}

// The cube's frame at a node (undoing its twist), for the face texture.
vec3 cubeLocal(vec3 node, vec3 q) {
  for (int i = 0; i < 4; i++) {
    float ang = u_twist[i].w;
    if (ang == 0.0 || any(notEqual(node, u_twist[i].xyz))) continue;
    float c = cos(ang);
    float sn = sin(ang);
    int ax = int(u_taxis[i]);
    if (ax == 0) q.yz = mat2(c, sn, -sn, c) * q.yz;
    else if (ax == 1) q.xz = mat2(c, sn, -sn, c) * q.xz;
    else q.xy = mat2(c, sn, -sn, c) * q.xy;
  }
  return q;
}

// A simple procedural environment for chrome and obsidian: fog below, light above, soft panels.
vec3 envMap(vec3 r) {
  vec3 sky = mix(u_bg * 0.8 + 0.02, mix(u_glow, u_surf, 0.4), smoothstep(-0.4, 0.9, r.y));
  float panel = pow(max(0.0, sin(r.x * 5.0) * sin(r.z * 5.0 + 1.0)), 6.0);
  return sky + panel * 0.5 * u_glow;
}
#endif

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
#ifdef TENTACLE
  for (int i = 1; i <= 3; i++) {
    float h = 0.02 + 0.1 * float(i);
#else
  for (int i = 1; i <= 5; i++) {
    float h = 0.02 + 0.06 * float(i);
#endif
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
#ifdef TENTACLE
  for (int i = 0; i < 300; i++) {
#else
  for (int i = 0; i < 160; i++) {
#endif
    if (i >= u_steps) break;
    float d = map(ro + rd * t, id);
    if (d < 0.0008 + 0.0015 * t) { hit = true; break; }
#ifdef TENTACLE
    // The bent tubes' distance is approximate: step conservatively near them (the far-field
    // bounds are exact).
    t += d < 0.2 ? d * 0.8 : d;
#else
    t += d;
#endif
    if (t > u_far) break;
  }

  // Ran out of distance or steps: all fog (u_far sits where the fog is nearly opaque anyway).
  if (!hit) {
    o = vec4(u_bg * u_bgA, u_bgA);
    return;
  }
  float fogT = exp(-t * u_fog);
#ifdef TENTACLE
  // The march stops at u_far: fade into the fog before it, so there's no edge.
  fogT *= 1.0 - smoothstep(0.7 * u_far, u_far, t);
#endif

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
#ifdef TENTACLE
  // Materials (Tentacube's four), crossfaded by u_mat.
  float ndv = max(0.0, dot(n, v));
  float fres = pow(1.0 - ndv, 4.0);
  vec3 r = reflect(rd, n);
  float light = 0.95 * difH * head + 0.22 * difK + 0.06 * amb;
  vec3 chrome = envMap(r) * (0.5 + 0.5 * fres) * (0.4 + 0.6 * head) + spec * 0.8;
  vec3 film = 0.5 + 0.5 * cos(6.2831853 * (vec3(0.0, 0.33, 0.67) + 1.6 * (1.0 - ndv) + 0.25 * r.y));
  vec3 irid = film * (0.25 + 0.75 * light) + spec * 0.7;
  vec3 glowCol = id == 0 ? u_glow : axisCol;
  vec3 emiss = albedo * light * 0.25 + glowCol * (0.55 + 0.35 * ndv);
  vec3 obsid = vec3(0.012) * light + envMap(r) * fres * 0.3 +
               pow(max(0.0, dot(n, hK)), 120.0) * 1.2 + pow(ndv, 80.0) * head * 0.8;
  col = (u_mat.x * chrome + u_mat.y * irid + u_mat.z * emiss + u_mat.w * obsid) * ao;
  col = mix(col, albedo * light * ao, u_ink * 0.7); // on paper: mostly ink
#endif

  // Emission.
  vec3 e = vec3(0.0);
#ifdef TENTACLE
  if (id == 0) {
    // Cube faces: spectrogram rings, newest at the centre, the same on all six faces and under a
    // quarter turn (so a settled twist looks like none). Farther cubes show older rows.
    vec3 lq = cubeLocal(node, q);
    vec3 aq = abs(lq);
    vec2 f = aq.x > aq.y && aq.x > aq.z ? lq.zy : aq.y > aq.z ? lq.xz : lq.xy;
    f /= u_tg.w;
    float ring = max(abs(f.x), abs(f.y));
    vec2 af = abs(f);
    float band = min(af.x, af.y) / max(1e-4, max(af.x, af.y)); // 0 on the axes, 1 on diagonals
    vec3 dn = abs(node - floor(u_cam + 0.5));
    vec4 h = hist(band, ring * FACE_ROWS + (dn.x + dn.y + dn.z) * NODE_ROWS);
    float inside = smoothstep(1.0, 0.85, ring);
    vec3 tint = band < 0.5 ? mix(u_ax, u_ay, band * 2.0) : mix(u_ay, u_az, band * 2.0 - 1.0);
    e += tint * h.r * h.r * 1.4 * inside * (0.4 - 0.2 * u_ink);
    e += u_glow * pulses(node) * 1.5;
  } else {
    // Tentacles: a running light flowing root → tip with the axis's band energy (an accent).
    float along = id == 1 ? q.x : id == 2 ? q.y : q.z;
    float sAlong = abs(along) / u_tg.x;
    float run = pow(0.5 + 0.5 * cos(6.2831853 * (sAlong * 1.2 - u_time * 0.6)), 10.0);
    e += axisCol * axisLight * (0.03 + 0.7 * run);
    vec3 pr = node;
    if (id == 1) pr.x = p.x;
    else if (id == 2) pr.y = p.y;
    else pr.z = p.z;
    e += u_glow * pulses(pr) * 1.6;
  }
#else
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
#endif

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
