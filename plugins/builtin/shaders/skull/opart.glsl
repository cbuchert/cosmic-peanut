// Skull Trip: the op-art stripe field, shared by the skull pass (reflections, eye whirlpools) and
// the composite pass (the full-screen stripes). Mirrored in src/lib/opart.js (opField), whose tests
// check the bounds the anti-strobe budget relies on (FIELD_MAX, FLOW_SENS).
//
// Screen units: the skull's centre is the origin, half the window's short side is 1.

uniform vec2 u_view;        // window size / its short side: v_uv * 2 - 1 scaled to screen units
uniform float u_freq;       // stripe frequency, rad of phase per unit of field
uniform float u_phase;      // global phase (mod 2π), streams the stripes outward
uniform float u_flow;       // warp-field clock
uniform float u_warp;       // Warp param (effective)
uniform float u_duty;       // stripe threshold: > 0 fattens the black bands
uniform vec4 u_outline;     // skull outline: screen units per object unit, tilt, jaw drop, -
uniform vec2 u_ripples[8];  // (radius, amplitude) per beat ripple
uniform float u_wave[32];   // slew-limited waveform, mirrored left/right around the skull
uniform vec3 u_ink;
uniform vec3 u_paper;
uniform float u_paperAlpha; // 0 for "black only": white stripes are transparent

const float PI = 3.14159265;
const float WAVE_PHASE = 1.0;   // lib/opart.js WAVE_PHASE
const float RIPPLE_PHASE = 3.0; // phase a full-strength ripple adds at its crest
const float RIPPLE_WIDTH = 0.2;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Three octaves, normalized to 0..1.
float fbm(vec2 p) {
  float s = 0.5 * vnoise(p);
  p = p * 2.03 + vec2(1.7, 9.2);
  s += 0.25 * vnoise(p);
  p = p * 2.03 + vec2(1.7, 9.2);
  s += 0.125 * vnoise(p);
  return s / 0.875;
}

vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Approximate distance to an ellipse (good enough for flowing contours).
float sdEllipse2(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}

// Signed distance (screen units) to the skull's silhouette, roughly: cranium plus jaw.
float outline(vec2 q) {
  vec2 o = rot2(q, -u_outline.y) / u_outline.x;
  float cranium = sdEllipse2(o - vec2(0.0, 0.2), vec2(0.95, 1.0));
  float jaw = sdEllipse2(o - vec2(0.0, -0.72 - u_outline.z), vec2(0.52, 0.34));
  return smin(cranium, jaw, 0.3) * u_outline.x;
}

// The warped field: stripes are its contour lines. Marble domain warp + a whirlpool, around the
// skull's silhouette so the bands flow round it.
float opField(vec2 p) {
  vec2 q = p;
  vec2 o = vec2(fbm(q * 0.8 + vec2(0.0, 0.5 * u_flow)), fbm(q * 0.8 + vec2(5.2 - 0.4 * u_flow, 1.3)));
  q += u_warp * 0.42 * (o * 2.0 - 1.0);
  float r = length(q);
  q = rot2(q, u_warp * 1.3 * exp(-0.8 * r) * sin(0.6 * u_flow + 1.0));
  return outline(q) + 0.25 * u_warp * (fbm(q * 1.6 - vec2(0.3 * u_flow, 0.0)) - 0.5);
}

// Waveform bend, mirrored left/right: -1..1 by angle round the skull (0 at the top).
float waveAt(vec2 p) {
  float a = abs(atan(p.x, p.y)) / PI * 31.0;
  int i = int(floor(a));
  return mix(u_wave[i], u_wave[min(i + 1, 31)], fract(a));
}

// Beat ripples launch at the skull's silhouette and run outward, shaped like it.
float ripplePhase(vec2 p) {
  float d = max(outline(p), 0.0);
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float x = (d - u_ripples[i].x) / RIPPLE_WIDTH;
    s += u_ripples[i].y * exp(-x * x);
  }
  return RIPPLE_PHASE * s;
}

// Stripe phase at p (radians): contour lines of the field, streaming outward.
float opPhase(vec2 p, bool full) {
  float ph = u_freq * opField(p) - u_phase;
  if (full) ph += WAVE_PHASE * waveAt(p) + ripplePhase(p);
  return ph;
}

// Anti-aliased stripe: 1 on white (paper), 0 on black (ink). lib/opart.js stripe().
float opStripe(float ph) {
  float v = sin(ph);
  float w = max(fwidth(v) * 0.75, 1e-4);
  return clamp(0.5 + (v - u_duty) / (2.0 * w), 0.0, 1.0);
}
