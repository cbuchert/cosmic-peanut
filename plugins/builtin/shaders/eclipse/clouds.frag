#version 300 es
// Eclipse's marbled ink clouds, as smooth fields at a third of the canvas resolution (they're
// low-frequency; eclipse.frag cuts the crisp edges and streaks from them at full resolution).
// Out (encoded 0–1): r = density (edge where it crosses the threshold), g = marbling phase,
// b = vein noise, a = tone.
precision highp float;

uniform vec2 u_res;     // canvas px
uniform vec2 u_center;  // canvas px
uniform float u_radius; // canvas px per unit
uniform float u_outer;  // ring outer radius, units
uniform float u_time;   // drift clock, s

in vec2 v_uv;
out vec4 outColor;

// #include noise

void main() {
  vec2 p = (v_uv * u_res - u_center) / u_radius;
  float r = length(p);
  vec2 c = p * 1.25;
  float tc = u_time * 0.015;
  vec2 w1 = vec2(fbm(c + vec2(0.0, tc)), fbm(c + vec2(5.2, 1.3 - tc)));
  vec2 w2 = vec2(fbm(c + 2.2 * w1 + vec2(1.7, 9.2)), fbm(c + 2.2 * w1 + vec2(8.3, 2.8)));
  float f = fbm(c + 2.0 * w2 + vec2(tc, 0.0));
  // Masses hug the corona and thin out toward the corners…
  float env = smoothstep(u_outer + 0.02, u_outer + 0.22, r) * (1.0 - smoothstep(1.0, 2.0, r));
  // …clustered on some sides, like the cover's banks of ink (drifting slowly round).
  env *= smoothstep(-0.25, 0.3, fbm(p / max(r, 1e-3) * 0.9 + vec2(0.3 * tc, 4.1)) + 0.22);
  // Erosion: finer ridges dragged along the warp eat feathery, branching bays into the edges.
  float ero = 1.0 - abs(gnoise(c * 6.0 + 5.0 * w2, BIG)) * 1.6;
  float dens = (f + 0.3 * w1.x + 0.05 * ero) * env - 0.25 * (1.0 - env);
  float m = 14.0 * f + 6.0 * w2.x;
  float vein = gnoise(c * 3.0 + 4.0 * w2, BIG);
  float tone = f + 0.3 * w2.y;
  outColor = clamp(vec4(dens * 0.5 + 0.5, m / 40.0 + 0.5, vein * 0.5 + 0.5, tone * 0.5 + 0.5), 0.0, 1.0);
}
