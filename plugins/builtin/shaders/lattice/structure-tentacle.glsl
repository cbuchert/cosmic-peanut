// Structure "tentacle" (Tentacle Lattice): a Tentacube-style creature at every integer node — a
// rounded cube with six tapered, swaying tentacles reaching toward its neighbours
// (lib/tentacle-lattice.js holds the tested shapes this mirrors: tubeRadius, strutDistance,
// handshake, handshakeReach, swellWeight). Beat pulses make the tentacles they pass reach and
// touch tips; the pulse's node twists a quarter turn.
//
// Distance: an exact proxy (rods of radius u_env + a bounding sphere per cube) far from the
// surface; near it the bent tubes, whose distance is approximate (Lipschitz up to ~1.25), so
// structStep takes 0.8 of it there.

uniform vec4 u_tg;        // tentacle reach, root radius, tip radius, cube half-size
uniform vec3 u_sway;      // sway amplitude (cells at the tip), wave clock, ripple 0–1
uniform float u_env;      // worst-case tentacle extent from its strut's axis (cells)
uniform float u_swell;    // bass swell (× cube size) at the camera
uniform vec4 u_twist[4];  // lib/tentacle-lattice.js TWIST_CAP; node xyz, angle (rad)
uniform float u_taxis[4]; // twist axis: 0 x, 1 y, 2 z
uniform float u_shake;    // handshake scale (lib/lattice.js motionScale: Reduce motion damps it)

const int STRUCT_MAX_STEPS = 300;
const int STRUCT_AO_SAMPLES = 3;
const float STRUCT_AO_SPACING = 0.1;
const float STRUCT_HIST_GAIN = 0.4;
const float STRUCT_HIST_INK = 0.2;
const float STRUCT_HIST_FADE = 0.85; // histEdge where the history starts fading out
const float STRUCT_RUN_GAIN = 0.7;
const float STRUCT_PULSE_GAIN = 1.6;
const float STRUCT_NODE_PULSE_GAIN = 1.5;
const float PROXY_NEAR = 0.03; // within this of the bound, evaluate the bent tentacles exactly
// The march stops at u_far (short here): fade into the fog before it, so there's no edge.
#define STRUCT_FAR_FADE

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
float sceneSDF(vec3 p, out int id) {
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

// The bent tubes' distance is approximate: step conservatively near them (the far-field bounds
// are exact).
float structStep(float d) {
  return d < 0.2 ? d * 0.8 : d;
}

// Pulses run along the struts: the shortest path on the strut network is the L1 distance.
float pulseMetric(vec3 a, vec3 b) {
  vec3 d = abs(a - b);
  return d.x + d.y + d.z;
}

// Material id → 0: a node face (shows the history), 1: a tentacle (running light).
int structKind(int id) {
  return id == 0 ? 0 : 1;
}

// Material id → which band lights and tints it: 0 x (bass), 1 y (mids), 2 z (treble).
int structAxis(int id) {
  return id == 1 ? 0 : id == 2 ? 1 : 2;
}

// Cube faces: spectrogram rings, newest at the centre, the same on all six faces and under a
// quarter turn (so a settled twist looks like none). Farther cubes show older rows.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  vec3 lq = cubeLocal(node, q);
  vec3 aq = abs(lq);
  vec2 f = aq.x > aq.y && aq.x > aq.z ? lq.zy : aq.y > aq.z ? lq.xz : lq.xy;
  f /= u_tg.w;
  float ring = max(abs(f.x), abs(f.y));
  vec2 af = abs(f);
  float band = min(af.x, af.y) / max(1e-4, max(af.x, af.y)); // 0 on the axes, 1 on diagonals
  vec3 dn = abs(node - floor(u_cam + 0.5));
  histAt = vec2(band, ring * FACE_ROWS + (dn.x + dn.y + dn.z) * NODE_ROWS);
  histWave = 0.0;
  histEdge = ring;
  pulseAt = node;
}

// Tentacles: a running light flowing root → tip (an accent); pulses measured along the strut.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  float along = id == 1 ? q.x : id == 2 ? q.y : q.z;
  float sAlong = abs(along) / u_tg.x;
  runPhase = sAlong * 1.2;
  vec3 pr = node;
  if (id == 1) pr.x = p.x;
  else if (id == 2) pr.y = p.y;
  else pr.z = p.z;
  pulseAt = pr;
}
