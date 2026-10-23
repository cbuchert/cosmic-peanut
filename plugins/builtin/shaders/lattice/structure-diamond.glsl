// Structure "diamond" (Lattice): carbon's crystal as ball and stick. Atoms on A (even coordinate
// sum; period 2) and B = A + ½, each bonded to four of the other kind along the tetrahedral
// directions (bond √3/2, 109.47° apart). Exact distances (the nearest A and B atoms and their
// eight bonds; Lipschitz 1), so the march takes full steps. lib/structure-diamond.js is the
// tested mirror of everything here.

uniform vec3 u_geo;      // bond radius, atom radius (lib/structure-diamond.js geometry)

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.06;
const float STRUCT_HIST_GAIN = 0.45;
const float STRUCT_HIST_INK = 0.25;
const float STRUCT_HIST_FADE = 0.82;
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.0;
const float STRUCT_NODE_PULSE_GAIN = 1.5;

const float DIA_L = 0.8660254; // bond length
// The bonds from an A atom (a B atom's are their negatives).
const vec3 DV0 = vec3(0.5, 0.5, 0.5);
const vec3 DV1 = vec3(0.5, -0.5, -0.5);
const vec3 DV2 = vec3(-0.5, 0.5, -0.5);
const vec3 DV3 = vec3(-0.5, -0.5, 0.5);

vec3 diaPar() {
  return mod(u_origin, 2.0);
}

// The nearest A atom (even coordinate sum).
vec3 diaA(vec3 P) {
  vec3 r = floor(P + 0.5);
  if (mod(r.x + r.y + r.z, 2.0) > 0.5) {
    vec3 f = P - r;
    vec3 a = abs(f);
    if (a.x >= a.y && a.x >= a.z) r.x += f.x >= 0.0 ? 1.0 : -1.0;
    else if (a.y >= a.z) r.y += f.y >= 0.0 ? 1.0 : -1.0;
    else r.z += f.z >= 0.0 ? 1.0 : -1.0;
  }
  return r;
}

// Distance from q (relative to a bond's start) to the bond along v; `t` its parameter.
float diaBond(vec3 q, vec3 v, out float t) {
  t = clamp(dot(q, v) / 0.75, 0.0, 1.0);
  return length(q - v * t);
}

vec3 diaDir(int k) {
  return k == 0 ? DV0 : k == 1 ? DV1 : k == 2 ? DV2 : DV3;
}

// The bonds along DV0 share out the three bands by layer (A atom's coordinate sum / 2, mod 3).
int diaLayer(vec3 A) {
  vec3 abs0 = A - diaPar() + u_origin;
  return int(mod(0.5 * (abs0.x + abs0.y + abs0.z), 3.0) + 0.5) % 3;
}

// Distance to the crystal; `id` = 0 atom, 1–3 bonds along DV1–DV3, 4–6 bonds along DV0 by band.
float sceneSDF(vec3 p, out int id) {
  vec3 P = p + diaPar();
  vec3 A = diaA(P);
  vec3 B = diaA(P - 0.5) + 0.5;
  vec3 qa = P - A;
  vec3 qb = P - B;
  float d = min(length(qa), length(qb)) - u_geo.y;
  id = 0;
  float best = 1e9;
  int k = 0;
  bool fromB = false;
  float t;
  for (int i = 0; i < 4; i++) {
    vec3 v = diaDir(i);
    float da = diaBond(qa, v, t);
    float db = diaBond(qb, -v, t);
    if (da < best) { best = da; k = i; fromB = false; }
    if (db < best) { best = db; k = i; fromB = true; }
  }
  float ds = best - u_geo.x;
  if (ds < d) {
    d = ds;
    id = k > 0 ? k : 4 + diaLayer(fromB ? B - DV0 : A);
  }
  return d;
}

float structStep(float d) {
  return d;
}

// Pulses run along the bonds. From an A atom b, d = Σ mⱼ vⱼ with Σ mⱼ = σ has the unique solution
// mⱼ = d·vⱼ + σ/4 and the hop count is Σ|mⱼ|; σ runs 0 → 1 from a bond's A end to its B end, so
// points on bonds are exact too.
float pulseMetric(vec3 a, vec3 b) {
  vec3 A = a + diaPar();
  float q = 0.25 * min(1.0, length(A - diaA(A)) / DIA_L);
  vec3 d = a - b;
  return DIA_L * (abs(dot(d, DV0) + q) + abs(dot(d, DV1) + q) + abs(dot(d, DV2) + q) + abs(dot(d, DV3) + q));
}

int structKind(int id) {
  return id == 0 ? 0 : 1;
}

int structAxis(int id) {
  return id >= 4 ? id - 4 : id - 1;
}

// An atom: the history on six patches facing the axes (y the waveform, the others the
// spectrogram); atoms more hops from the camera's show older rows.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 par = diaPar();
  vec3 P = p + par;
  vec3 A = diaA(P);
  vec3 B = diaA(P - 0.5) + 0.5;
  vec3 atom = dot(P - A, P - A) <= dot(P - B, P - B) ? A : B;
  vec3 an = abs(n);
  vec2 f;
  histWave = 0.0;
  if (an.x > an.y && an.x > an.z) f = n.zy;
  else if (an.y > an.z) { f = n.xz; histWave = 1.0; }
  else f = n.xy;
  f *= 1.41421356;
  pulseAt = atom - par;
  float hops = pulseMetric(pulseAt, diaA(u_cam + par) - par) / DIA_L;
  histAt = vec2(clamp(0.5 + 0.5 * f.x, 0.0, 1.0), (0.5 - 0.5 * f.y) * FACE_ROWS + hops * NODE_ROWS);
  histEdge = max(abs(f.x), abs(f.y));
}

// A bond: the running light runs away from each atom; pulses are measured on its axis.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 par = diaPar();
  vec3 P = p + par;
  vec3 A = diaA(P);
  vec3 B = diaA(P - 0.5) + 0.5;
  vec3 v = diaDir(id >= 4 ? 0 : id);
  float ta;
  float tb;
  float da = diaBond(P - A, v, ta);
  float db = diaBond(P - B, -v, tb);
  vec3 axisPt = da <= db ? A + v * ta : B - v * tb;
  float t = da <= db ? ta : tb;
  runPhase = 2.0 * min(t, 1.0 - t);
  pulseAt = axisPt - par;
}
