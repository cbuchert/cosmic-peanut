// Structure "cubic" (Lattice): a rounded cube at every integer node, rods along the three axes.
// Exact distances (Lipschitz 1), so the march takes full steps.

uniform vec3 u_geo;      // rod radius, cube half-size, cube rounding (lib/lattice.js geometry)

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.06;
const float STRUCT_HIST_GAIN = 0.45;
const float STRUCT_HIST_INK = 0.25;
const float STRUCT_HIST_FADE = 0.82; // histEdge where the history starts fading out
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.0;
const float STRUCT_NODE_PULSE_GAIN = 1.5;

// Distance to the lattice; `id` = 0 cube, 1 x-rod, 2 y-rod, 3 z-rod.
float sceneSDF(vec3 p, out int id) {
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

float structStep(float d) {
  return d;
}

// Pulses run along the rods: the shortest path on the rod network is the L1 distance.
float pulseMetric(vec3 a, vec3 b) {
  vec3 d = abs(a - b);
  return d.x + d.y + d.z;
}

// Material id → 0: a node face (shows the history), 1: a strut (running light).
int structKind(int id) {
  return id == 0 ? 0 : 1;
}

// Material id → which band lights and tints it: 0 x (bass), 1 y (mids), 2 z (treble).
int structAxis(int id) {
  return id == 1 ? 0 : id == 2 ? 1 : 2;
}

// A node face at p (normal n): the history lookup (band 0–1, age in rows), whether it shows the
// waveform (1) or the spectrogram (0), its edge coordinate (0 centre, 1 edge) and where pulse
// fronts are measured from.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  // The history scrolls across each face; faces facing y show the waveform, the others the
  // spectrogram. Farther cubes show older rows, so the music ripples outward.
  vec3 an = abs(n);
  vec2 f;
  histWave = 0.0;
  if (an.x > an.y && an.x > an.z) f = q.zy;
  else if (an.y > an.z) { f = q.xz; histWave = 1.0; }
  else f = q.xy;
  f /= u_geo.y;
  vec3 dn = abs(node - floor(u_cam + 0.5));
  float age = (0.5 - 0.5 * f.y) * FACE_ROWS + (dn.x + dn.y + dn.z) * NODE_ROWS;
  float band = clamp(0.5 + 0.5 * f.x, 0.0, 1.0);
  histAt = vec2(band, age);
  histEdge = max(abs(f.x), abs(f.y));
  // A node lights as a pulse front passes through it.
  pulseAt = node;
}

// A strut at p: the running light's phase (it runs away from each node) and where pulse fronts
// are measured from (the node, with the rod's own axis replaced by the hit's position along it).
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 node = floor(p + 0.5);
  vec3 q = p - node;
  float along = id == 1 ? q.x : id == 2 ? q.y : q.z;
  float u = abs(along); // 0 at a node, 0.5 midway
  runPhase = u * 2.0;
  vec3 pr = node;
  if (id == 1) pr.x = p.x;
  else if (id == 2) pr.y = p.y;
  else pr.z = p.z;
  pulseAt = pr;
}
