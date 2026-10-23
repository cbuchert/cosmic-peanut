// Structure "bitruncated" (Lattice): the bitruncated cubic honeycomb, space filled with truncated
// octahedra (centres on a body-centred cubic lattice: all-even or all-odd integer points; period
// 2), drawn as their edges with small balls at the vertices. A point folds by the cube's mirrors
// (|·|, sorted) into one chamber of its own cell, which holds one square edge, one hexagon edge
// and one vertex. Exact distances (Lipschitz 1), so the march takes full steps.
// lib/structure-bitruncated.js is the tested mirror of everything here.

uniform vec3 u_geo;      // edge radius, vertex-ball radius (lib/structure-bitruncated.js geometry)

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.05;
const float STRUCT_HIST_GAIN = 0.45;
const float STRUCT_HIST_INK = 0.25;
const float STRUCT_HIST_FADE = 0.82;
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.0;
const float STRUCT_NODE_PULSE_GAIN = 1.5;

const float BIT_L = 0.70710678; // edge length
const vec3 BIT_V = vec3(1.0, 0.5, 0.0); // the chamber's vertex
const vec3 BIT_S = vec3(1.0, 0.0, 0.5); // ...the square edge's other end
const vec3 BIT_H = vec3(0.5, 1.0, 0.0); // ...the hexagon edge's other end

vec3 bitPar() {
  return mod(u_origin, 2.0);
}

// The nearest cell centre.
vec3 bitCentre(vec3 P) {
  vec3 e = 2.0 * floor(P * 0.5 + 0.5);
  vec3 o = 2.0 * floor((P - 1.0) * 0.5 + 0.5) + 1.0;
  vec3 de = P - e;
  vec3 dd = P - o;
  return dot(dd, dd) < dot(de, de) ? o : e;
}

// Fold P into its cell's chamber: q = |P − c| sorted largest first, k = which axis each came from.
void bitFold(vec3 P, out vec3 c, out vec3 q, out vec3 k) {
  c = bitCentre(P);
  q = abs(P - c);
  k = vec3(0.0, 1.0, 2.0);
  if (q.y > q.x) { q.xy = q.yx; k.xy = k.yx; }
  if (q.z > q.y) { q.yz = q.zy; k.yz = k.zy; }
  if (q.y > q.x) { q.xy = q.yx; k.xy = k.yx; }
}

// Back from the chamber: the point with chamber coordinates w, in P's cell and octant.
vec3 bitUnfold(vec3 w, vec3 P, vec3 c, vec3 k) {
  vec3 s = vec3(greaterThanEqual(P - c, vec3(0.0))) * 2.0 - 1.0;
  vec3 u = w.x * vec3(equal(vec3(k.x), vec3(0, 1, 2))) + w.y * vec3(equal(vec3(k.y), vec3(0, 1, 2))) +
           w.z * vec3(equal(vec3(k.z), vec3(0, 1, 2)));
  return c + s * u;
}

float bitSeg(vec3 q, vec3 a, vec3 b, out float t) {
  vec3 u = b - a;
  vec3 w = q - a;
  t = clamp(dot(w, u) / dot(u, u), 0.0, 1.0);
  return length(w - u * t);
}

// Distance to the foam; `id` = 0 vertex ball, 1–3 square edges, 4–6 hexagon edges (by the axis
// normal to the edge's face plane in the chamber: x for square edges, z for hexagon edges).
float sceneSDF(vec3 p, out int id) {
  vec3 c;
  vec3 q;
  vec3 k;
  bitFold(p + bitPar(), c, q, k);
  float d = length(q - BIT_V) - u_geo.y;
  id = 0;
  float t;
  float s1 = bitSeg(q, BIT_V, BIT_S, t);
  float s2 = bitSeg(q, BIT_V, BIT_H, t);
  float ds = min(s1, s2) - u_geo.x;
  if (ds < d) {
    d = ds;
    id = s1 <= s2 ? 1 + int(k.x + 0.5) : 4 + int(k.z + 0.5);
  }
  return d;
}

float structStep(float d) {
  return d;
}

// The nearest vertex to P (the chamber's vertex, unfolded).
vec3 bitVertex(vec3 P) {
  vec3 c;
  vec3 q;
  vec3 k;
  bitFold(P, c, q, k);
  return bitUnfold(BIT_V, P, c, k);
}

// Hops to a vertex r cells from the source, estimated (the sodalite net has no closed form):
// exact one hop out, within about a hop and a half by four.
float bitEstimate(float r) {
  return max(r, 1.41421356 * r - 0.29);
}

// Pulses run along the edges: a point on an edge axis is reached through its nearer end.
float pulseMetric(vec3 a, vec3 b) {
  vec3 par = bitPar();
  vec3 A = a + par;
  vec3 B = b + par;
  vec3 n0 = bitVertex(A);
  vec3 e = A - n0;
  float s = length(e);
  float d0 = bitEstimate(length(n0 - B));
  if (s < 1e-4) return d0;
  vec3 n1 = floor(2.0 * (n0 + e * (BIT_L / s)) + 0.5) * 0.5;
  return min(d0 + s, bitEstimate(length(n1 - B)) + BIT_L - s);
}

int structKind(int id) {
  return id == 0 ? 0 : 1;
}

int structAxis(int id) {
  return id >= 4 ? id - 4 : id - 1;
}

// A vertex ball: the history on six patches facing the axes (y the waveform, the others the
// spectrogram); balls farther from the camera show older rows.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 par = bitPar();
  vec3 v = bitVertex(p + par);
  vec3 an = abs(n);
  vec2 f;
  histWave = 0.0;
  if (an.x > an.y && an.x > an.z) f = n.zy;
  else if (an.y > an.z) { f = n.xz; histWave = 1.0; }
  else f = n.xy;
  f *= 1.41421356;
  float hops = bitEstimate(length(v - par - u_cam)) / BIT_L;
  histAt = vec2(clamp(0.5 + 0.5 * f.x, 0.0, 1.0), (0.5 - 0.5 * f.y) * FACE_ROWS + hops * NODE_ROWS);
  histEdge = max(abs(f.x), abs(f.y));
  pulseAt = v - par;
}

// An edge: the running light runs away from each vertex; pulses are measured on its axis.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 par = bitPar();
  vec3 P = p + par;
  vec3 c;
  vec3 q;
  vec3 k;
  bitFold(P, c, q, k);
  vec3 b = id >= 4 ? BIT_H : BIT_S;
  float t;
  bitSeg(q, BIT_V, b, t);
  runPhase = 2.0 * min(t, 1.0 - t);
  pulseAt = bitUnfold(mix(BIT_V, b, t), P, c, k) - par;
}
