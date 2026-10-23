// Structures "gyroid", "schwarz-p", "schwarz-d" (Lattice): a thickened triply periodic minimal
// surface, |f(k p) − c| ≤ t, whose saddle walls split space into two interlocking labyrinths
// (lib/tpms.js mirrors f, its bounds and the music's bend; the camera flies one labyrinth).
// The define picks f: TPMS_GYROID, TPMS_P or TPMS_D.
//
// Distance: (|f − c| − t) / (k surfGrad) is about the real distance near the walls, and
// structStep scales it by surfGrad / lip, |∇f|'s bound (tested in tpms.test.js), so the march
// never passes a wall.
// Surface: the walls show the history (age = distance from the camera, so the music ripples
// outward over them; band from the wall's normal, so it follows the saddles without a seam).
// Ridge lines where a wall crosses the planes q ≡ 0 (mod π) of each axis carry the axis light.
// Pulses: rings spreading over the walls (Euclidean distance) from an impact point on the wall.

uniform vec4 u_tpms;   // k (radians per cell), level offset c, half-thickness t, 1 / (k surfGrad)
uniform vec3 u_tphase; // the origin modulo the period, × k (radians)

#define STRUCT_FAR_FADE

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.1;
const float STRUCT_HIST_GAIN = 0.45;
const float STRUCT_HIST_INK = 0.25;
const float STRUCT_HIST_FADE = 0.82;
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.0;
const float STRUCT_NODE_PULSE_GAIN = 1.8;

const float TPMS_ROWS = 6.0;      // history rows per cell of distance from the camera
const float TPMS_LINE_W = 0.016;  // ridge-line half-width (cells) at the camera...
const float TPMS_LINE_GROW = 0.3; // ...growing by this fraction per cell away (no aliasing)
const float TPMS_RUN = 0.8;       // running-light cycles per cell along a ridge line

// f at q (radians) and its gradient; and STRUCT_LIP = lip / surfGrad (lib/tpms.js).
#if defined(TPMS_GYROID)
const float STRUCT_LIP = 1.75 / 1.55;
float tpmsF(vec3 q, out vec3 g) {
  vec3 s = sin(q);
  vec3 c = cos(q);
  g = c * c.yzx - s.zxy * s;
  return dot(s, c.yzx);
}
#elif defined(TPMS_P)
const float STRUCT_LIP = 1.75 / 1.35;
float tpmsF(vec3 q, out vec3 g) {
  vec3 c = cos(q);
  g = -sin(q);
  return c.x + c.y + c.z;
}
#else
const float STRUCT_LIP = 1.75 / 1.55;
float tpmsF(vec3 q, out vec3 g) {
  vec3 s = sin(q);
  vec3 c = cos(q);
  g = vec3(c.x * s.y * s.z + c.x * c.y * c.z - s.x * s.y * c.z - s.x * c.y * s.z,
           s.x * c.y * s.z - s.x * s.y * c.z + c.x * c.y * c.z - c.x * s.y * s.z,
           s.x * s.y * c.z - s.x * c.y * s.z - c.x * s.y * s.z + c.x * c.y * c.z);
  return s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z;
}
#endif

// Distance (cells, about) to the sheet; `id` = 0 wall, 1/2/3 a ridge line across x/y/z.
float sceneSDF(vec3 p, out int id) {
  vec3 q = u_tpms.x * p + u_tphase;
  vec3 g;
  float f = tpmsF(q, g);
  float d = (abs(f - u_tpms.y) - u_tpms.z) * u_tpms.w;
  // Ridge lines: the in-surface distance to the plane is the plane distance over the sine of
  // the wall's angle to it, so compare w |g| with the width × the gradient across the axis.
  vec3 w = abs(q - 3.14159265 * floor(q / 3.14159265 + 0.5)) / u_tpms.x * length(g);
  vec3 across = sqrt(max(vec3(1e-6), dot(g, g) - g * g));
  vec3 m = w - TPMS_LINE_W * (1.0 + TPMS_LINE_GROW * length(p - u_cam)) * across;
  id = 0;
  if (m.x < 0.0 && m.x <= m.y && m.x <= m.z) id = 1;
  else if (m.y < 0.0 && m.y <= m.z) id = 2;
  else if (m.z < 0.0) id = 3;
  return d;
}

float structStep(float d) {
  return d / STRUCT_LIP;
}

// Pulses spread over the walls as rings: straight-line distance from the impact point.
float pulseMetric(vec3 a, vec3 b) {
  return length(a - b);
}

int structKind(int id) {
  return id == 0 ? 0 : 1;
}

int structAxis(int id) {
  return id == 1 ? 0 : id == 2 ? 1 : 2;
}

// A wall: the history at age = distance from the camera (rows), band from the normal (bass on
// walls facing down, treble facing up), waveform in occasional soft patches, fading out as the
// age reaches the ring's oldest rows.
void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 q = u_tpms.x * p + u_tphase;
  float age = length(p - u_cam) * TPMS_ROWS;
  histAt = vec2(clamp(0.5 + 0.5 * n.y, 0.0, 1.0), age);
  vec3 h = sin(0.5 * q);
  histWave = smoothstep(0.45, 0.8, h.x * h.y * h.z * 2.0);
  histEdge = clamp(age / (u_rows - 2.0), 0.0, 1.0);
  pulseAt = p;
}

// A ridge line: its running light streams away from the camera.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  runPhase = length(p - u_cam) * TPMS_RUN;
  pulseAt = p;
}
