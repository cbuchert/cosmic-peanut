// Lattice family — shared declarations (included first). See README.md for the structure contract.
//
// Every position is relative to an integer origin near the camera (u_origin, absolute cells;
// u_cam is the camera's offset from it), so precision never degrades however far the flight goes.

uniform vec2 u_res;
uniform vec3 u_cam;
uniform vec3 u_fwd;
uniform vec3 u_up;
uniform vec3 u_right;
uniform float u_tanHalf;
uniform float u_fog;     // density per cell
uniform float u_far;     // march limit, cells
uniform int u_steps;     // march budget (≤ the structure's STRUCT_MAX_STEPS)
uniform vec3 u_bg;
uniform vec3 u_surf;
uniform vec3 u_ax;       // x-axis colour (bass)
uniform vec3 u_ay;       // y (mids)
uniform vec3 u_az;       // z (treble)
uniform vec3 u_glow;     // beat-pulse colour
uniform float u_ink;     // 1: draw light as ink
uniform float u_bgA;     // 1: fog to the background colour, 0: to transparent
uniform vec3 u_light;    // x, y, z axis light (lib/lattice.js createAxisLight)
uniform float u_time;    // the running-light clock
uniform vec3 u_origin;   // the integer origin (absolute cells), e.g. for per-cell hashes
// Beat pulses (lib/lattice-pulses.js): source xyz (relative to the origin) and front distance
// (cells, in the structure's pulseMetric), all PULSE_CAP slots and their brightness...
uniform vec4 u_pulse[8];
uniform float u_pamp[8];
// ...and the live ones packed first, for loops inside the SDF.
uniform vec4 u_live[8];
uniform float u_liveAmp[8];
uniform int u_np;
uniform sampler2D u_hist; // W bands × N rows: R spectrum level, G waveform (0.5 = 0)
uniform float u_head;
uniform float u_rows;

const float FACE_ROWS = 40.0;  // history rows across one node face
const float NODE_ROWS = 7.0;   // extra rows of age per cell (L1) from the camera's node

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
