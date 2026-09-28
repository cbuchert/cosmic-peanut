#version 300 es
// The scope: polar phosphor (+ a gentle glow), contacts, sweep arm and its beam fan, and a static
// graticule (range rings, crosshair, bearing ticks, bezel), all analytic per pixel.
// The canvas is transparent and premultiplied: colour is "light on black" and alpha is its
// brightest channel, so the face is dark but see-through and only the light floats over the desktop.
precision highp float;
out vec4 o;
uniform sampler2D u_phos;
uniform vec2 u_center;      // px (drawing buffer, GL y-up)
uniform float u_radius;     // px
uniform float u_turn;       // arm bearing, turns 0–1
uniform vec3 u_col;         // phosphor glow
uniform vec3 u_hot;         // hot core
uniform float u_grat;       // graticule brightness 0–1
uniform float u_gain;       // global brightness (flash-limited)
uniform vec4 u_contacts[32];// bearing (turns), radius (0–1), brightness, strength
uniform int u_count;

const float TAU = 6.28318530718;
const float BEZEL = 0.035;

// 1 on a line at distance d (px) from its center, antialiased, `w` px half-width.
float line(float d, float w) { return 1.0 - smoothstep(w, w + 1.0, abs(d)); }

float phos(vec2 p) {
  float r = length(p);
  if (r > 1.0) return 0.0;
  float b = fract(atan(p.x, p.y) / TAU);
  return texture(u_phos, vec2(b, r)).r;
}

// Phosphor response: quiet returns sink toward black, loud ones bloom (CRT-like gamma).
float respond(float v) { return pow(max(v, 0.0), 1.8); }

void main() {
  vec2 p = (gl_FragCoord.xy - u_center) / u_radius;   // scope units, north = +y
  float r = length(p);
  float px = 1.0 / u_radius;                          // one pixel in scope units
  if (r > 1.0 + BEZEL + 3.0 * px) { o = vec4(0.0); return; }
  float bearing = fract(atan(p.x, p.y) / TAU);
  float s = max(1.0, u_radius / 700.0);               // line weight scale (1 at ~1440p)

  // Phosphor returns, plus a soft glow from a ring of wider taps (cheap bloom).
  float ph = respond(r <= 1.0 ? texture(u_phos, vec2(bearing, r)).r : 0.0);
  float g = 0.0;
  float k = 0.014;
  g += phos(p + vec2(k, 0.0)) + phos(p - vec2(k, 0.0)) + phos(p + vec2(0.0, k)) + phos(p - vec2(0.0, k));
  g += phos(p + vec2(k, k) * 1.6) + phos(p - vec2(k, k) * 1.6) + phos(p + vec2(k, -k) * 1.6) + phos(p - vec2(k, -k) * 1.6);
  g = respond(g * 0.125);

  // Sweep arm and the illuminated fan trailing it.
  float behind = fract(u_turn - bearing);             // 0 at the arm, growing behind it
  vec2 dir = vec2(sin(u_turn * TAU), cos(u_turn * TAU));
  float along = dot(p, dir);
  float across = abs(p.x * dir.y - p.y * dir.x) * u_radius;
  float inside = step(r, 1.0);
  float arm = along > 0.0 ? line(across, 0.9 * s) + 0.5 * exp(-across / (5.0 * s)) : 0.0;
  arm *= inside * (0.55 + 0.45 * smoothstep(0.0, 0.3, r));
  float fan = inside * exp(-behind / 0.035) * 0.16 * smoothstep(0.0, 0.2, r);

  // Contacts: a hot core with a halo.
  float blips = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= u_count) break;
    vec4 c = u_contacts[i];
    float a = c.x * TAU;
    vec2 q = c.y * vec2(sin(a), cos(a));
    float d = length(p - q) * u_radius;
    float size = (5.0 + 7.0 * c.w) * s;
    blips += c.z * (exp(-(d * d) / (size * size)) + 0.22 * exp(-d / (3.5 * size)));
  }

  // Graticule: range rings, crosshair, bearing ticks (5° / 10° / 30°), bezel.
  float gr = 0.0;
  if (r <= 1.0) {
    for (int i = 1; i <= 4; i++) gr += line((r - float(i) * 0.25) * u_radius, 0.5 * s) * (i == 4 ? 1.0 : 0.6);
    gr += 0.5 * (line(p.x * u_radius, 0.4 * s) + line(p.y * u_radius, 0.4 * s));
    float deg = bearing * 360.0;
    float tickLen = mod(deg + 2.5, 30.0) < 5.0 ? 0.07 : (mod(deg + 2.5, 10.0) < 5.0 ? 0.04 : 0.02);
    float nearest = floor(deg / 5.0 + 0.5) * 5.0;
    float dist = abs(deg - nearest) / 360.0 * TAU * r * u_radius;
    float t10 = mod(nearest, 10.0) == 0.0 ? 1.0 : 0.6;
    gr += line(dist, 0.5 * s) * step(1.0 - tickLen, r) * t10;
  }
  // Bezel: a faint lit band outside the face with a crisp inner edge.
  float bz = 0.0;
  if (r > 1.0) {
    float t = (r - 1.0) / BEZEL;
    bz = 0.10 * (1.0 - smoothstep(0.0, 1.0, t)) * (0.7 + 0.3 * p.y / max(r, 1e-4));
    bz += 0.35 * line((r - 1.0 - BEZEL) * u_radius, 0.6 * s);
  }
  gr = min(gr, 1.2) * u_grat * 0.28;

  vec3 c = u_col * (1.15 * ph + 0.55 * g + fan + gr + bz * max(u_grat, 0.3))
         + u_hot * (0.35 * ph * ph + 0.9 * arm + 1.2 * blips);
  c *= u_gain;
  c = 1.0 - exp(-1.3 * c);                            // soft shoulder, never clips hard
  o = vec4(c, max(c.r, max(c.g, c.b)));
}
