#version 300 es
// Eclipse's marbled ink clouds, as smooth fields at a third of the canvas resolution (they're
// low-frequency; eclipse.frag cuts the crisp edges and streaks from them at full resolution).
// The masses orbit the eclipse (u_angle, faster when loud), are born, grow and dissolve (their
// density is 3D noise whose third axis is the formation clock u_evolve), billow out near the
// spectrum's loud angles (u_lev row 2), are pushed outward by beat shockwaves (u_pulses) and get
// fresh billows of ink at the ring's edge on strong beats (u_billows).
// Out (encoded 0–1): r = density (edge where it crosses the threshold), g = marbling phase,
// b = vein noise, a = tone.
precision highp float;

uniform vec2 u_res;     // canvas px
uniform vec2 u_center;  // canvas px
uniform float u_radius; // canvas px per unit
uniform float u_outer;  // ring outer radius, units
uniform float u_time;   // drift clock, s
uniform float u_th;     // the edge threshold eclipse.frag cuts the density at
uniform float u_angle;  // orbit angle, rad (lib/eclipse.js createFlow)
uniform float u_evolve; // formation clock (createFlow)
uniform vec2 u_pulses[4];  // shockwaves: (distance past the ring, amplitude)
uniform vec4 u_billows[6]; // (angle, distance past the ring, amplitude, seed)
uniform float u_kick;      // beat surge × the background drive, ≈0–1
uniform sampler2D u_lev;   // 256 × 3: row 2 = cloud density bias by angle (createCloudBias)

in vec2 v_uv;
out vec4 outColor;

const float TAU = 6.28318531;

// #include noise

void main() {
  vec2 p = (v_uv * u_res - u_center) / u_radius;
  float r = length(p);
  vec2 dir = p / max(r, 1e-3);
  float ang = atan(p.x, -p.y); // screen angle, as the corona's (0 = bottom)
  float rho = r - u_outer;

  // Shockwaves: sample from further in where a pulse passes, so the ink is pushed outward.
  float push = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = (rho - u_pulses[i].x) / 0.14;
    push += u_pulses[i].y * exp(-d * d);
  }
  // A beat's surge breathes the whole sky of ink outward at once (u_kick), then it settles.
  vec2 q = p / (1.0 + 0.08 * u_kick) - dir * 0.12 * push;

  // The orbit: the whole sky of ink turns about the eclipse.
  float ca = cos(u_angle), sa = sin(u_angle);
  q = mat2(ca, sa, -sa, ca) * q;

  vec2 c = q * 1.25;
  float tc = u_time * 0.015;
  float ev = u_evolve;
  vec2 w1 = vec2(fbm(c + vec2(0.0, tc)), fbm(c + vec2(5.2, 1.3 - tc)));
  vec2 w2 = vec2(fbm(c + 2.2 * w1 + vec2(1.7, 9.2)), fbm(c + 2.2 * w1 + vec2(8.3, 2.8)));
  vec2 cf = c + 2.0 * w2 + vec2(tc, 0.0);
  vec2 ff = fbm3(cf, ev);
  float f = ff.x;
  float fl = ff.y;
  // Masses hug the corona and thin out toward the corners…
  float env = smoothstep(u_outer + 0.06, u_outer + 0.3, r) * (1.0 - smoothstep(1.0, 2.0, r));
  // …clustered on some sides, like the cover's banks of ink (re-forming with the clock too).
  vec2 qd = q / max(r, 1e-3);
  env *= smoothstep(-0.25, 0.3, 1.2 * gnoise3(vec3(qd * 0.9 + vec2(0.3 * tc, 4.1), 0.35 * ev)) + 0.22);
  // Erosion: finer ridges dragged along the warp eat feathery, branching bays into the edges.
  float ero = 1.0 - abs(gnoise(c * 6.0 + 5.0 * w2, BIG)) * 1.6;
  // The spectrum by angle: the ink billows out near loud angles and thins near quiet ones.
  float bias = texture(u_lev, vec2(ang / TAU + 0.5, 2.5 / 3.0)).r;
  float near = 1.0 - smoothstep(u_outer + 0.4, 1.7, r);
  float lift = 0.2 * bias * near * smoothstep(u_outer + 0.02, u_outer + 0.15, r);
  float dens = (f + 0.3 * w1.x + 0.05 * ero) * env - 0.25 * (1.0 - env) + lift;
  // Fine detail may erode the edge of a mass but never raise islands beside it: it only acts where
  // the coarse density already reaches the edge. So no small blobs or specks, only big shapes.
  float coarse = (fl + 0.3 * w1.x) * env - 0.25 * (1.0 - env) + lift;
  // Beat billows: big soft masses swelling at the ring's edge and drifting outward, inked by the
  // coarse field so they're never round.
  float bil = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 b = u_billows[i];
    float da = mod(ang - b.x + 3.14159265, TAU) - 3.14159265;
    float rc = u_outer + 0.1 + b.y;
    vec2 d = vec2(da * r, r - rc) / (0.13 + 0.12 * b.y);
    bil += b.z * exp(-dot(d, d));
  }
  bil *= 0.55 * (0.75 + 0.5 * fl + 0.3 * w1.y) * step(u_outer + 0.01, r);
  dens += bil;
  coarse += bil;
  dens = mix(min(dens, coarse), dens, smoothstep(u_th - 0.02, u_th + 0.06, coarse));
  float m = 14.0 * f + 6.0 * w2.x;
  float vein = gnoise(c * 3.0 + 4.0 * w2, BIG);
  float tone = f + 0.3 * w2.y;
  outColor = clamp(vec4(dens * 0.5 + 0.5, m / 40.0 + 0.5, vein * 0.5 + 0.5, tone * 0.5 + 0.5), 0.0, 1.0);
}
