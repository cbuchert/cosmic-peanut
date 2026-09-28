#version 300 es
// Scalar step: advect temperature (r) and fuel (g) along the velocity, a touch of diffusion, fuel
// fed from the fuel line along the bottom, jet heat at the roots, fuel burning into heat, and noisy
// cooling that tears the flames into tongues.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_scal;
uniform sampler2D u_vel;
uniform sampler2D u_seed;  // r = fuel, g = jet strength (0–2), along x
uniform vec2 u_venc;
uniform vec2 u_texel;      // 1 / sim size
uniform float u_aspect;
uniform float u_dt;
uniform float u_time;
uniform float u_inject;    // bed temperature at seed = 1
uniform float u_ember;     // steady heat along the bed so silence still glows faintly (0 = none)
uniform float u_flare;     // extra heat everywhere along the base (onsets, flash-limited)
uniform float u_jetHeat;   // heat a full-strength jet adds at its root
uniform float u_jetVel;    // upward speed of a full-strength jet, heights/s
uniform float u_cool;      // cooling rate, 1/s
uniform float u_burn;      // fuel → heat rate, 1/s
// #include noise

vec2 dec(vec4 t) { return (t.xy - u_venc.y) / u_venc.x; }

void main() {
  vec2 v = dec(texture(u_vel, v_uv));
  // A jet also lifts the heat directly (on top of the projected flow, which spreads a local push
  // sideways), so a blast reaches height within ~0.2 s instead of welling up.
  vec4 seed = texture(u_seed, vec2(v_uv.x, 0.5));
  float tongue = 0.25 + 1.6 * max(0.0, gnoise(vec3(v_uv.x * u_aspect * 11.0, u_time * 1.3, 11.0)) + 0.25);
  v.y += u_jetVel * seed.g * tongue * (1.0 - smoothstep(0.0, 0.85, v_uv.y));
  vec2 back = v_uv - u_dt * v * vec2(1.0 / u_aspect, 1.0);
  vec4 s = texture(u_scal, back);
  vec4 nb = texture(u_scal, back + vec2(u_texel.x, 0)) + texture(u_scal, back - vec2(u_texel.x, 0)) +
            texture(u_scal, back + vec2(0, u_texel.y)) + texture(u_scal, back - vec2(0, u_texel.y));
  s = mix(s, nb * 0.25, 0.15);
  float T = s.r;
  float F = s.g;

  // The fuel line: a thin bed along the bottom whose temperature and fuel are held at least at
  // what the waveform under it asks for (a source, not an accumulator, so loudness maps to height).
  float bed = 1.0 - smoothstep(0.0, 0.03, v_uv.y);
  // Break the bed into flickering jets so even a smooth passage throws separate tongues.
  float jets = 0.55 + 0.9 * max(0.0, gnoise(vec3(v_uv.x * u_aspect * 14.0, u_time * 1.7, 3.0)) + 0.35);
  float want = (u_inject * seed.r + u_flare) * jets;
  T = max(T, bed * (want + u_ember));
  F = max(F, bed * want * 1.3);
  // A jet heats a taller root than the bed, so the column it blasts upward is full of fire.
  // Mostly as fuel, torn by the same jets noise, so it burns on the way up instead of sitting as a block.
  float root = 1.0 - smoothstep(0.0, 0.14, v_uv.y);
  float jh = u_jetHeat * seed.g * root * jets;
  T = max(T, 0.5 * jh);
  F = max(F, jh);

  float burn = F * (1.0 - exp(-u_burn * u_dt));
  F -= burn;
  T += burn;

  vec2 p = v_uv * vec2(u_aspect, 1.0);
  float n = gnoise(vec3(p * vec2(9.0, 5.0) - vec2(0.0, u_time * 2.2), u_time * 0.7));
  float n2 = gnoise(vec3(p * vec2(22.0, 13.0) - vec2(0.0, u_time * 3.5), u_time * 1.3 + 5.0));
  float cool = u_cool * (1.0 + 1.6 * (n + 0.5 * n2)) * (0.6 + 0.8 * v_uv.y);
  // Inside a jet's column the gas cools more slowly, so the blast reads as one tall spike.
  cool *= 1.0 - 0.55 * min(seed.g, 1.0) * (1.0 - smoothstep(0.2, 0.9, v_uv.y));
  T = max(0.0, T - u_dt * max(0.0, cool) * (0.12 + T));

  // Open top: let heat leave rather than pooling against the edge.
  T *= 1.0 - smoothstep(0.96, 1.0, v_uv.y);
  o = vec4(min(T, 4.0), min(F, 4.0), 0.0, 1.0);
}
