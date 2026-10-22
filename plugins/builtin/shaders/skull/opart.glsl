// Skull Trip: the op-art stripe field, shared by the skull pass (reflections, eye whirlpools) and
// the composite pass (the full-screen stripes). Mirrored in src/lib/opart.js (opField, outlineField,
// ripplePhase), whose tests check the bounds the anti-strobe budget relies on (FIELD_MAX, FLOW_SENS,
// TWIST_SENS, each reserve). The constants come from opart.js too (opartDefines, prepended at load).
//
// The stripes are contour lines of a distance field: the skull's silhouette smooth-min'd with the
// loop emitters, marble-warped and twisted into a whirlpool. The global phase grows, so new closed
// loops are born at the skull and at each emitter and grow outward off the screen.
//
// Screen units: the skull's centre is the origin, half the window's short side is 1.

uniform vec2 u_view;        // window size / its short side: v_uv * 2 - 1 scaled to screen units
uniform float u_freq;       // stripe frequency, rad of phase per unit of field
uniform float u_phase;      // global phase (mod 2π), streams the stripes outward
uniform float u_flow;       // warp-field clock
uniform float u_warp;       // Warp param (effective)
uniform float u_duty;       // stripe threshold: > 0 fattens the black bands
uniform float u_twist;      // whirlpool angle at the centre (signed by the swirl direction)
uniform vec4 u_outline;     // skull outline: screen units per object unit, tilt, jaw drop, -
uniform vec2 u_ripples[RIPPLES];   // (outline distance, amplitude) per beat ripple
uniform float u_wave[WAVE_POINTS]; // slew-limited waveform, mirrored left/right around the skull
uniform vec4 u_emitters[EMITTERS]; // (x, y, offset, -) per loop emitter; idle ones sit far above
uniform float u_bulge[BULGE_SECTORS]; // spectrum by angle: 0 straight up (highs) … straight down (bass)
uniform vec3 u_ink;
uniform vec3 u_paper;
uniform float u_paperAlpha; // 0 for "black only": white stripes are transparent

const float PI = 3.14159265;

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
// skull's silhouette and the emitters (smooth-min'd, so their loops meet and fold into each other).
float opField(vec2 p) {
  vec2 q = p;
  vec2 o = vec2(fbm(q * 0.8 + vec2(0.0, 0.5 * u_flow)), fbm(q * 0.8 + vec2(5.2 - 0.4 * u_flow, 1.3)));
  q += u_warp * 0.42 * (o * 2.0 - 1.0);
  float r = length(q);
  q = rot2(q, u_twist * exp(-TWIST_FALLOFF * r));
  float f = outline(q);
  for (int i = 0; i < EMITTERS; i++) f = smin(f, length(q - u_emitters[i].xy) + u_emitters[i].z, EMIT_K);
  return f + 0.25 * u_warp * (fbm(q * 1.6 - vec2(0.3 * u_flow, 0.0)) - 0.5);
}

// Waveform bend, mirrored left/right: -1..1 by angle round the skull (0 at the top).
float waveAt(vec2 p) {
  float a = abs(atan(p.x, p.y)) / PI * float(WAVE_POINTS - 1);
  int i = int(floor(a));
  return mix(u_wave[i], u_wave[min(i + 1, WAVE_POINTS - 1)], fract(a));
}

// Spectrum bulge, mirrored left/right: 0..1 by angle (sector centres at π(i + ½)/n from the top).
float bulgeAt(vec2 p) {
  float a = clamp(abs(atan(p.x, p.y)) / PI * float(BULGE_SECTORS) - 0.5, 0.0, float(BULGE_SECTORS - 1));
  int i = int(floor(a));
  return mix(u_bulge[i], u_bulge[min(i + 1, BULGE_SECTORS - 1)], fract(a));
}

// Beat ripples rise from under the skull and run outward across the screen, shaped like it.
// lib/opart.js ripplePhase().
float ripplePhase(float d) {
  float s = 0.0;
  for (int i = 0; i < RIPPLES; i++) {
    float x = (d - u_ripples[i].x) / RIPPLE_WIDTH;
    s += u_ripples[i].y * exp(-x * x);
  }
  return RIPPLE_PHASE * s;
}

// Stripe phase at p (radians): contour lines of the field, streaming outward. The ripples and the
// spectrum push the stripes outward (less phase), the waveform bends them either way.
float opPhase(vec2 p, bool full) {
  float ph = u_freq * opField(p) - u_phase;
  if (full) {
    float d = max(outline(p), -1.0);
    ph += WAVE_PHASE * waveAt(p) - ripplePhase(d) - BULGE_PHASE * bulgeAt(p) * exp(-max(d, 0.0) / 1.5);
  }
  return ph;
}

// Anti-aliased stripe: 1 on white (paper), 0 on black (ink). lib/opart.js stripe().
float opStripe(float ph) {
  float v = sin(ph);
  float w = max(fwidth(v) * 0.75, 1e-4);
  return clamp(0.5 + (v - u_duty) / (2.0 * w), 0.0, 1.0);
}
