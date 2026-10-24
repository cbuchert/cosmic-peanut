// Structure "octet" (Lattice): an octet truss. A rounded cube at every node of a face-centred
// cubic lattice (even coordinate sum; period 2), 12 struts per node along the face diagonals.
// The struts chain into whole lines: in the planes x = k they are y ∓ z ≡ k (mod 2), and likewise
// for y and z. Exact distances (Lipschitz 1), so the march takes full steps. lib/structure-octet.js
// is the tested mirror of everything here.

uniform vec3 u_geo;      // strut radius, cube half-size, cube rounding (lib/structure-octet.js geometry)

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.06;
const float STRUCT_HIST_GAIN = 0.45;
const float STRUCT_HIST_INK = 0.25;
const float STRUCT_HIST_FADE = 0.82;
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.0;
const float STRUCT_NODE_PULSE_GAIN = 1.5;

const float OCT_L = 1.41421356; // strut length

// The structure's own frame: the origin's parity added back (the truss repeats every 2 cells).
vec3 octPar() {
  return mod(u_origin, 2.0);
}

// The nearest node (even coordinate sum).
vec3 octNode(vec3 P) {
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

// Hops between nodes d apart on the strut graph.
float octHops(vec3 d) {
  d = abs(d);
  return max(max(d.x, max(d.y, d.z)), 0.5 * (d.x + d.y + d.z));
}

// One line family: planes a = k (integers), lines s = n with n ≡ k (mod 2), s a diagonal
// coordinate. Returns (squared distance, k, n) of the nearest line.
vec3 octFamily(float a, float s) {
  float k0 = 2.0 * floor(a * 0.5 + 0.5);
  float n0 = 2.0 * floor(s * 0.5 + 0.5);
  float k1 = 2.0 * floor((a - 1.0) * 0.5 + 0.5) + 1.0;
  float n1 = 2.0 * floor((s - 1.0) * 0.5 + 0.5) + 1.0;
  float d0 = (a - k0) * (a - k0) + 0.5 * (s - n0) * (s - n0);
  float d1 = (a - k1) * (a - k1) + 0.5 * (s - n1) * (s - n1);
  return d0 < d1 ? vec3(d0, k0, n0) : vec3(d1, k1, n1);
}

// Family `id` (1–6): its plane normal and diagonal gradient.
void octFamilyAxes(int id, out vec3 ea, out vec3 g) {
  if (id == 1) { ea = vec3(1, 0, 0); g = vec3(0, 1, -1); }
  else if (id == 2) { ea = vec3(1, 0, 0); g = vec3(0, 1, 1); }
  else if (id == 3) { ea = vec3(0, 1, 0); g = vec3(1, 0, -1); }
  else if (id == 4) { ea = vec3(0, 1, 0); g = vec3(1, 0, 1); }
  else if (id == 5) { ea = vec3(0, 0, 1); g = vec3(1, -1, 0); }
  else { ea = vec3(0, 0, 1); g = vec3(1, 1, 0); }
}

// Distance to the truss; `id` = 0 cube, 1–2 struts in the x planes, 3–4 y planes, 5–6 z planes.
float sceneSDF(vec3 p, out int id) {
  vec3 P = p + octPar();
  float d = sdRoundBox(P - octNode(P), vec3(u_geo.y - u_geo.z), u_geo.z);
  id = 0;
  float best = octFamily(P.x, P.y - P.z).x;
  int fid = 1;
  float f = octFamily(P.x, P.y + P.z).x;
  if (f < best) { best = f; fid = 2; }
  f = octFamily(P.y, P.x - P.z).x;
  if (f < best) { best = f; fid = 3; }
  f = octFamily(P.y, P.x + P.z).x;
  if (f < best) { best = f; fid = 4; }
  f = octFamily(P.z, P.x - P.y).x;
  if (f < best) { best = f; fid = 5; }
  f = octFamily(P.z, P.x + P.y).x;
  if (f < best) { best = f; fid = 6; }
  float ds = sqrt(best) - u_geo.x;
  if (ds < d) { d = ds; id = fid; }
  return d;
}

float structStep(float d) {
  return d;
}

// Pulses run along the struts: the strut-graph distance from node b to a (a node, or a point on a
// strut axis), through the strut's nearer end.
float pulseMetric(vec3 a, vec3 b) {
  vec3 par = octPar();
  vec3 A = a + par;
  vec3 B = b + par;
  vec3 n0 = octNode(A);
  vec3 e = A - n0;
  float s = length(e);
  float d0 = OCT_L * octHops(n0 - B);
  if (s < 1e-4) return d0;
  vec3 n1 = floor(n0 + e * (OCT_L / s) + 0.5);
  return min(d0 + s, OCT_L * octHops(n1 - B) + OCT_L - s);
}

int structKind(int id) {
  return id == 0 ? 0 : 1;
}

// The struts in the x planes are lit by the bass, y by the mids, z by the treble.
int structAxis(int id) {
  return (id - 1) / 2;
}

// A cube face: the history scrolls across it (y faces the waveform, others the spectrogram);
// cubes more hops from the camera's node show older rows.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 par = octPar();
  vec3 P = p + par;
  vec3 node = octNode(P);
  vec3 q = P - node;
  vec3 an = abs(n);
  vec2 f;
  histWave = 0.0;
  if (an.x > an.y && an.x > an.z) f = q.zy;
  else if (an.y > an.z) { f = q.xz; histWave = 1.0; }
  else f = q.xy;
  f /= u_geo.y;
  float hops = octHops(node - octNode(u_cam + par));
  histAt = vec2(clamp(0.5 + 0.5 * f.x, 0.0, 1.0), (0.5 - 0.5 * f.y) * FACE_ROWS + hops * NODE_ROWS);
  histEdge = max(abs(f.x), abs(f.y));
  pulseAt = node - par;
}

// A strut: the running light runs away from each node; pulses are measured at the hit's
// projection onto the strut's axis.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 par = octPar();
  vec3 P = p + par;
  vec3 ea;
  vec3 g;
  octFamilyAxes(id, ea, g);
  float a = dot(P, ea);
  float s = dot(P, g);
  vec3 line = octFamily(a, s);
  vec3 axisPt = P - ea * (a - line.y) - g * (0.5 * (s - line.z));
  // Along the line, nodes sit at the integers of its first in-plane coordinate.
  float along = ea.x > 0.5 ? axisPt.y : axisPt.x;
  runPhase = 2.0 * abs(along - floor(along + 0.5));
  pulseAt = axisPt - par;
}
