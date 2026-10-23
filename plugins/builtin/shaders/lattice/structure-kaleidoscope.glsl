// Structure "kaleidoscope" (Lattice): a kaleidoscopic IFS grown in every cell of a mirror-repeated
// lattice, with naves carved along the cell edges (lib/kaleido.js has the design and the JS mirror
// of sceneSDF; lib/structure-kaleidoscope.js the music).
//
// Distance: Knighty's Menger KIFS, bent by a rotation, with a running derivative; its unit box
// fills a cell. Each step is a mirror or a similarity, so it is a bound up to the rotation's
// overhang, and the march steps 0.8 of it. Steps stop early where a step's boxes would be under a
// pixel or two (detail the screen can't show).
// Surfaces: the nave walls (cut through the fractal) are the node faces — the history wraps
// around each nave — and the fractal itself takes the running light and the beat pulses, which
// also bend the fold offsets a little where their fronts pass (the local ripple).

uniform mat3 u_kRot;    // the fold rotation
uniform vec4 u_kOS;     // fold offset (xyz) and scale
uniform float u_kRipple; // how far a passing pulse front bends the offset (fraction)
uniform vec3 u_kOrg;    // the origin modulo the period (exact), so folding never loses precision

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.06;
const float STRUCT_HIST_GAIN = 0.55;
const float STRUCT_HIST_INK = 0.3;
const float STRUCT_HIST_FADE = 0.8;
const float STRUCT_RUN_GAIN = 0.35;
const float STRUCT_PULSE_GAIN = 1.8;
const float STRUCT_NODE_PULSE_GAIN = 1.2;
#define STRUCT_FAR_FADE

const float K_PERIOD = 6.0;
const float K_HALF = 3.0;
const float K_NAVE = 1.3;
const int K_ITERS = 7;
const float K_FOOT = 1.5;   // stop at steps whose boxes are under this many pixels
const float K_EDGE = 0.12;

// Fold a position (relative to the origin) into [0, K_HALF]³ by mirrors through the nodes and
// the mid-planes.
vec3 kFold(vec3 p) {
  vec3 m = p + u_kOrg + K_HALF;
  return abs(m - K_PERIOD * floor(m / K_PERIOD) - K_HALF);
}

// Offsets from the three nave axes through this cell's edges (two coordinates on mid-planes).
float kNaves(vec3 q) {
  vec3 a = K_HALF - q;
  return min(length(a.xy), min(length(a.yz), length(a.xz)));
}

// The ripple: how strongly live pulse fronts pass near p (0 when none).
float kRipple(vec3 p) {
  float w = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_np) break;
    float x = (length(p - u_live[i].xyz) - u_live[i].w) / 0.7;
    w += u_liveAmp[i] * exp(-x * x);
  }
  return min(w, 1.5);
}

// id: 0 a nave wall; 1 + axis: the fractal (axis = the final box's dominant axis).
float sceneSDF(vec3 p, out int id) {
  vec3 q = kFold(p);
  float nave = K_NAVE - kNaves(q);
  vec3 z = (K_HALF - q) / K_HALF; // centred on the cell edges: its central tunnels are the naves
  float s = u_kOS.w;
  vec3 o = u_kOS.xyz * (1.0 + u_kRipple * kRipple(p)) * (s - 1.0);
  float foot = length(p - u_cam) * (2.0 * u_tanHalf / u_res.y) * K_FOOT / K_HALF;
  float dr = 1.0;
  for (int i = 0; i < K_ITERS; i++) {
    // This step's boxes would be under a pixel or two: the coarser fractal will do.
    if (1.0 / dr < foot) break;
    z = abs(z);
    if (z.x < z.y) z.xy = z.yx;
    if (z.x < z.z) z.xz = z.zx;
    if (z.y < z.z) z.yz = z.zy;
    z = u_kRot * z;
    z.xy = s * z.xy - o.xy;
    z.z = s * z.z;
    if (z.z > 0.5 * o.z) z.z -= o.z;
    dr *= s;
  }
  vec3 az = abs(z);
  vec3 b = az - 1.0;
  float d = (length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0)) / dr * K_HALF;
  if (nave > d) {
    id = 0;
    return nave;
  }
  id = 1 + (az.x >= az.y && az.x >= az.z ? 0 : az.y >= az.z ? 1 : 2);
  return d;
}

float structStep(float d) {
  return 0.8 * d;
}

float pulseMetric(vec3 a, vec3 b) {
  return length(a - b);
}

int structKind(int id) {
  return id == 0 ? 0 : 1;
}

int structAxis(int id) {
  return id == 0 ? 1 : id - 1;
}

// A nave wall: the history wraps around the nave (band by angle about its axis) and runs along
// it (age by the position along the axis, and older farther from the camera).
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 q = kFold(p);
  vec3 a = K_HALF - q;
  float dxy = length(a.xy);
  float dyz = length(a.yz);
  float dxz = length(a.xz);
  vec2 c;
  float along;
  if (dxy <= dyz && dxy <= dxz) { c = a.xy; along = q.z; }
  else if (dyz <= dxz) { c = a.yz; along = q.x; }
  else { c = a.xz; along = q.y; }
  float ang = atan(c.y, max(c.x, 1e-6)) / 1.5707963;
  histWave = 0.0;
  histAt = vec2(clamp(ang, 0.0, 1.0), along / K_HALF * FACE_ROWS + length(p - u_cam) * NODE_ROWS * 0.5);
  histEdge = 0.0;
  pulseAt = p;
}

// The fractal: a running light that runs outward from each node through the folds.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 q = kFold(p);
  runPhase = (q.x + q.y + q.z) / K_HALF;
  pulseAt = p;
}
