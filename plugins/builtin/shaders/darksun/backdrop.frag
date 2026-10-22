#version 300 es
// Dark Sun's painted backdrop: the sky (ash grey over salmon) and the ground (dark mauve) as
// watercolour washes - smooth, domain-warped fbm at low frequencies. No grain, no dots. Rendered at
// quarter resolution (nothing here has fine detail) and sampled, linearly filtered, by darksun.frag.
//
// The music moves it: the washes flow on a clock that runs faster with energy and surges on beats
// (u_time), warped harder as the music gets busier (u_turb); the sky's colour temperature and
// brightness follow spectral brightness and energy (u_warm, u_bright); faint shafts of light from
// the sun pulse with the bass (u_rays); and the dark ground is wet stone: the range and the beam
// shimmer in it (u_refl), and every beat sends a ripple out from where the beam meets it (u_rings).
precision highp float;

out vec4 o;

uniform sampler2D u_prof;  // N x 1 R32F: the range's depth per column, 0-1
uniform float u_n;         // N
uniform vec2 u_res;        // full drawing-buffer pixels
uniform vec2 u_scale;      // full pixels per backdrop texel
uniform float u_unit;      // min(w, h)
uniform float u_horizon;   // px from the top
uniform float u_time;      // flow clock
uniform float u_turb;      // 0-1: how hard the washes are warped
uniform float u_warm;      // 0 cool ash ... 0.5 the cover ... 1 warm
uniform float u_bright;    // sky brightness multiplier
uniform float u_glow;      // horizon glow level
uniform vec3 u_sun;        // x, y (px from the top), radius
uniform float u_rays;      // light shafts, 0-1
uniform float u_refl;      // ground reflection strength, 0-1
uniform float u_rangeHalf; // px
uniform float u_rangeDepth;// px for a full-level peak (with the beat's drop)
uniform float u_beamB;     // beam brightness
uniform vec2 u_rings[3];   // beat ripples: age (s), amplitude
uniform vec3 u_c[8];       // palette (see darksun.frag)

// #include noise

// A wash whose warp grows with the turbulence.
float washK(vec2 p, float t, float k) {
  vec2 w = vec2(fbm3(p * 0.9 + vec2(t, 0.0)), fbm3(p * 0.9 + vec2(4.7, 1.3 - t)));
  float v = fbm(p + (1.2 + 1.6 * k) * w);
  float edge = 1.0 - smoothstep(0.0, 0.07, abs(v - 0.52));
  return v - 0.12 * edge;
}

// Colour temperature: cool desaturates toward ash, warm deepens the pigment.
vec3 tone(vec3 c, float warm) {
  float l = dot(c, vec3(0.3, 0.59, 0.11));
  vec3 cool = mix(vec3(l), c, 0.35);
  vec3 hot = clamp(mix(vec3(l), c, 1.4), 0.0, 1.0);
  return warm < 0.5 ? mix(cool, c, warm * 2.0) : mix(c, hot, warm * 2.0 - 1.0);
}

float depthAt(float x) {
  float s = clamp(x, 0.0, 1.0) * u_n - 0.5;
  float i0 = floor(s);
  float f = s - i0;
  float a = texelFetch(u_prof, ivec2(int(clamp(i0, 0.0, u_n - 1.0)), 0), 0).r;
  float b = texelFetch(u_prof, ivec2(int(clamp(i0 + 1.0, 0.0, u_n - 1.0)), 0), 0).r;
  return mix(a, b, f);
}

void main() {
  vec2 fc = gl_FragCoord.xy * u_scale;
  fc.y = u_res.y - fc.y;           // px, y down
  vec2 p = fc / u_unit;
  float hz = u_horizon;
  float t = u_time;
  float k = u_turb;
  float cx = 0.5 * u_res.x;
  vec3 SKY_TOP = tone(u_c[0], u_warm), SKY_LOW = tone(u_c[1], u_warm);
  vec3 GROUND = u_c[2], WASH = u_c[3], GLOW = u_c[4];
  vec3 bg;
  if (fc.y < hz) {
    float v = fc.y / hz;                                  // 0 top, 1 horizon
    float w1 = washK(p * vec2(1.1, 2.2) + vec2(0.0, 3.0), t * 0.02, k);
    float grad = smoothstep(0.2, 0.95, v + (0.3 + 0.15 * k) * (w1 - 0.5));
    vec3 sky = mix(SKY_TOP * 0.85, SKY_TOP, smoothstep(0.0, 0.35, v));
    sky = mix(sky, SKY_LOW, grad);
    // Vertical brush streaks and broad blooms of pigment.
    float vs = fbm3(vec2(p.x * 7.0 + t * 0.01, p.y * 0.35));
    float bloom = washK(p * 0.8 + vec2(9.1, 2.4), -t * 0.015, k);
    sky *= 0.86 + 0.2 * vs + (0.3 + 0.2 * k) * (bloom - 0.5);
    // Glow rising off the horizon, breathing with it.
    sky = mix(sky, mix(SKY_LOW, GLOW, 0.4), (0.25 + 0.2 * u_glow) * smoothstep(0.7 - 0.08 * u_glow, 1.0, v));
    // Faint shafts of light from the sun, slowly turning, pulsing with the bass.
    vec2 ds = (fc - u_sun.xy) / u_sun.z;
    float d = length(ds);
    if (d > 1.0) {
      float ang = atan(-ds.y, ds.x);
      float sh = noise(circ(ang + 0.004 * t, 3.5) + vec2(0.0, 0.05 * t));
      float shafts = smoothstep(0.45, 0.85, sh) * exp(-(d - 1.0) / 5.0) * smoothstep(1.0, 1.8, d);
      sky += mix(SKY_LOW, GLOW, 0.6) * shafts * (0.03 + 0.16 * u_rays);
    }
    bg = sky * u_bright;
  } else {
    float g = (fc.y - hz) / max(u_res.y - hz, 1.0);       // 0 horizon, 1 bottom
    // Beat ripples spreading from where the beam meets the ground (flattened: the ground recedes).
    vec2 imp = vec2(cx, hz + 0.72 * (u_res.y - hz));
    vec2 rq = (fc - imp) / u_unit * vec2(1.0, 3.2);
    float rd = length(rq);
    float ripple = 0.0;
    for (int i = 0; i < 3; i++) {
      float rr = u_rings[i].x * 0.55;                    // radius, unit-scaled
      float x = (rd - rr) / (0.025 + 0.05 * rr);
      ripple += u_rings[i].y * exp(-x * x) * sin(x * 2.4) * exp(-rr * 1.2);
    }
    vec2 pr = p + 0.03 * ripple * normalize(rq + 1e-4);  // the washes bend with the ripple
    float w1 = washK(pr * vec2(0.9, 2.6) + vec2(5.0, 0.0), t * 0.015, k);
    float w2 = washK(pr * vec2(2.4, 0.6) + vec2(1.3, 8.0), -t * 0.01, k);
    vec3 ground = mix(WASH, GROUND, smoothstep(0.0, 0.35, g + 0.25 * (w1 - 0.5)));
    ground *= 0.85 + (0.5 + 0.2 * k) * (w2 - 0.5) + 0.4 * (w1 - 0.5);
    // Faint horizontal strata near the horizon, drifting with the currents.
    float strata = fbm3(vec2(p.x * 0.8 + 0.01 * t, p.y * 40.0 + 2.0));
    ground += (strata - 0.5) * 0.06 * (1.0 - smoothstep(0.0, 0.3, g)) * WASH;
    // Wet stone: the range and the beam shimmer in it, broken into soft horizontal bands that
    // slide with the currents.
    float band = fbm3(vec2(p.x * 1.5 + 0.03 * t, p.y * 26.0 - 0.25 * t));
    float shimmer = smoothstep(0.35, 0.75, band);
    float wob = 0.012 * (fbm3(vec2(p.y * 18.0, 0.2 * t)) - 0.5);
    vec3 lightC = mix(GLOW, tone(u_c[1], u_warm), 0.45);
    float ux = (fc.x - cx) / u_rangeHalf + wob * u_unit / u_rangeHalf;
    float refl = 0.0;
    if (abs(ux) < 1.0) {
      float tip = depthAt(ux * 0.5 + 0.5) * u_rangeDepth;    // px below the horizon
      float below = fc.y - hz - tip;
      refl += (0.25 + 0.75 * tip / max(u_rangeDepth, 1.0)) * exp(-max(below, 0.0) / (0.12 * u_unit))
        * smoothstep(0.0, 0.02 * u_unit, below);
    }
    float bx = abs(fc.x - cx + wob * u_unit * 2.0) / u_unit;
    refl += u_beamB * 0.8 * exp(-bx / 0.02) * smoothstep(0.0, 0.3, g);
    ground += lightC * refl * shimmer * 0.35 * u_refl;
    // The ripple catches the light.
    ground += lightC * max(ripple, 0.0) * 0.2 * (0.4 + u_refl);
    bg = ground * mix(1.0, u_bright, 0.4);
  }
  o = vec4(bg, 1.0);
}
