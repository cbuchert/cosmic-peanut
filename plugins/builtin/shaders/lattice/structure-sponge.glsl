// Structure "sponge" (Lattice): a Menger sponge flown as an endless self-similar zoom
// (lib/structure-sponge.js has the design; lib/sponge-camera.js the path).
//
// Coordinates: the shader works in the camera's *local* cells about the zoom centre F:
// p = (frame − F) / u_zs, where u_zs is the camera's current scale (frame cells per local cell).
// spongeRuntime uploads u_cam and u_pulse that way. So every absolute length in the march and
// shade.glsl (fog, headlight, AO, normals, pulse width) stays fixed relative to the sponge around
// the camera, and a rebase (×3 about F, u_zs ×3) changes nothing on screen.
//
// Distances: IQ's Menger cross per level, a Lipschitz-1 bound. Holes narrower than a pixel or two
// fade in by growing from nothing (their own footprint test, so they never pop), and a point
// already far from a level's cells skips the finer levels (a coarser bound is still a bound).

uniform float u_zs;      // frame cells per local cell at the camera

const int STRUCT_MAX_STEPS = 160;
const int STRUCT_AO_SAMPLES = 5;
const float STRUCT_AO_SPACING = 0.07;
const float STRUCT_HIST_GAIN = 0.5;
const float STRUCT_HIST_INK = 0.28;
const float STRUCT_HIST_FADE = 0.8;
const float STRUCT_RUN_GAIN = 0.9;
const float STRUCT_PULSE_GAIN = 2.2;
const float STRUCT_NODE_PULSE_GAIN = 1.0;
#define STRUCT_FAR_FADE

const vec3 SPONGE_F = vec3(9.0, 4.5, 9.0);   // zoom centre, frame cells
const vec3 SPONGE_C = vec3(-31.5, 4.5, -31.5); // the rendered cube: centre and half-size
const float SPONGE_H = 40.5;
const int SPONGE_LEVELS = 13;   // hard cap: holes down to 1e-5 of the rendered cube
const float SPONGE_FOOT = 1.0;  // a level's holes fade in as their half-width grows 1–2 × this (px)
const float SPONGE_EDGE = 0.3; // edge band of a hole's corner, in cross units (1 = the hole's half-width)

// The level-m cross coordinates of q (rendered-cube units) at scale s = 3^m: ≥ 1 in a cell's
// middle third (2 at its centre).
vec3 spongeCross(vec3 q, float s) {
  vec3 a = mod(q * s, 2.0) - 1.0;
  return abs(1.0 - 3.0 * abs(a));
}

// The point p (local cells about F) in rendered-cube units, folded across the faces through F.
vec3 spongeQ(vec3 p) {
  vec3 w = SPONGE_F + p * u_zs;
  w.xz = SPONGE_F.xz - abs(w.xz - SPONGE_F.xz);
  return (w - SPONGE_C) / SPONGE_H;
}

// id = (level × 2 + edge) × 3 + axis: the level whose hole the surface belongs to, whether it is
// on the hole's corner edge (the strut kind) or its wall (a face), and the hole's axis.
float sceneSDF(vec3 p, out int id) {
  vec3 q = spongeQ(p);
  vec3 b = abs(q) - 1.0;
  float d = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0);
  // One pixel at p, in cube units.
  float foot = length(p - u_cam) * (2.0 * u_tanHalf / u_res.y) * u_zs / SPONGE_H;
  float s = 1.0;
  int lvl = 0;
  vec3 rw = vec3(0.0);
  float tw = 1.0;
  for (int m = 0; m < SPONGE_LEVELS; m++) {
    if (d > 2.0 / s) break; // far from this level's cells: the bound so far will do
    vec3 r = spongeCross(q, s);
    s *= 3.0;
    // This level's holes are 1/s half-wide: they grow in from nothing over 1–2 footprints.
    float fade = smoothstep(SPONGE_FOOT, 2.0 * SPONGE_FOOT, 1.0 / (s * max(foot, 1e-9)));
    if (fade <= 0.0) break;
    float thr = 2.0 - fade; // r at the hole's wall
    float r2 = max(min(r.x, r.y), min(max(r.x, r.y), r.z));
    float c = (r2 - thr) / s;
    if (c > d) {
      d = c;
      lvl = m;
      rw = r;
      tw = thr;
    }
  }
  float r1 = max(rw.x, max(rw.y, rw.z));
  int edge = r1 - tw < SPONGE_EDGE ? 1 : 0;
  int axis = rw.x <= rw.y && rw.x <= rw.z ? 0 : rw.y <= rw.z ? 1 : 2;
  id = (lvl * 2 + edge) * 3 + axis;
  return d * SPONGE_H / u_zs;
}

// The fading term moves by under 1% of the distance (it varies with the pixel footprint).
float structStep(float d) {
  return 0.98 * d;
}

// Pulses spread as spheres from their source, in local cells.
float pulseMetric(vec3 a, vec3 b) {
  return length(a - b);
}

int structKind(int id) {
  return (id / 3) % 2;
}

int structAxis(int id) {
  return id % 3;
}

// The sub-cube face coordinates (−1…1 each) at p, at the level that made the surface.
vec3 spongeFace(vec3 p, int id) {
  float s = pow(3.0, float(id / 6));
  vec3 a = mod(spongeQ(p) * s, 2.0) - 1.0;
  vec3 g = (a + 1.0) * 1.5;
  return fract(g) * 2.0 - 1.0;
}

void structNodeFace(vec3 p, vec3 n, int id, out vec2 histAt, out float histWave, out float histEdge,
                    out vec3 pulseAt) {
  vec3 f3 = spongeFace(p, id);
  vec3 an = abs(n);
  vec2 f;
  histWave = 0.0;
  if (an.x > an.y && an.x > an.z) f = f3.zy;
  else if (an.y > an.z) { f = f3.xz; histWave = 1.0; }
  else f = f3.xy;
  // Faces scroll through the history; farther ones (in local cells) show older rows.
  float age = (0.5 - 0.5 * f.y) * FACE_ROWS + length(p - u_cam) * NODE_ROWS * 0.6;
  histAt = vec2(clamp(0.5 + 0.5 * f.x, 0.0, 1.0), age);
  histEdge = max(abs(f.x), abs(f.y));
  pulseAt = p;
}

// A hole's corner edge: the running light runs out from each sub-cube's middle.
void structStrut(vec3 p, vec3 n, int id, out float runPhase, out vec3 pulseAt) {
  vec3 f3 = spongeFace(p, id);
  int axis = id % 3;
  float along = axis == 0 ? f3.x : axis == 1 ? f3.y : f3.z;
  runPhase = abs(along);
  pulseAt = p;
}
