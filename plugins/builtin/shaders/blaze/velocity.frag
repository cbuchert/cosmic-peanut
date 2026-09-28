#version 300 es
// Velocity step: self-advection (semi-Lagrangian), buoyancy from temperature, animated curl-noise
// turbulence, vorticity confinement, music jets, damping, and (spectrogram feed) each column's gas
// pulled toward that column's rise speed. Velocity is in screen heights per second, y up.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_vel;
uniform sampler2D u_scal;
uniform sampler2D u_curl;
uniform sampler2D u_seed;   // g = jet strength (0–2), b = rise speed (heights/s), along x
uniform vec2 u_venc;
uniform float u_aspect;   // sim width / height
uniform float u_dt;       // sim seconds this step
uniform float u_time;
uniform float u_buoy;
uniform float u_turb;
uniform float u_vort;     // 0 disables confinement (and u_curl is unused)
uniform float u_damp;
uniform float u_texelH;   // one texel in height units
uniform float u_jetVel;   // upward speed a full-strength jet drives its column to
uniform float u_rise;     // pull rate (1/s) toward the column's rise speed; 0 = off (waveform feed)
// #include noise

vec2 dec(vec4 t) { return (t.xy - u_venc.y) / u_venc.x; }

// Divergence-free turbulence: the curl of an animated scalar potential, two octaves.
vec2 curlNoise(vec2 p, float t) {
  const float e = 0.02;
  vec3 q = vec3(p, t);
  vec3 q2 = vec3(p * 2.3 + 7.1, t * 1.7);
  float n1 = gnoise(q + vec3(0, e, 0)) + 0.45 * gnoise(q2 + vec3(0, e * 2.3, 0));
  float n2 = gnoise(q - vec3(0, e, 0)) + 0.45 * gnoise(q2 - vec3(0, e * 2.3, 0));
  float n3 = gnoise(q + vec3(e, 0, 0)) + 0.45 * gnoise(q2 + vec3(e * 2.3, 0, 0));
  float n4 = gnoise(q - vec3(e, 0, 0)) + 0.45 * gnoise(q2 - vec3(e * 2.3, 0, 0));
  return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
}

void main() {
  vec2 toUv = vec2(1.0 / u_aspect, 1.0);
  vec2 v = dec(texture(u_vel, v_uv));
  vec2 va = dec(texture(u_vel, v_uv - u_dt * v * toUv));
  vec4 s = texture(u_scal, v_uv);
  float T = s.r;

  va.y += u_dt * u_buoy * T;

  vec2 p = v_uv * vec2(u_aspect, 1.0);
  // Noise scrolls upward with the flames so eddies ride on them instead of standing still.
  vec2 turb = curlNoise(p * 6.0 - vec2(0.0, u_time * 2.0), u_time * 1.1);
  // Mostly sideways: flames sway and lick; buoyancy owns the vertical.
  va += u_dt * u_turb * turb * vec2(1.0, 0.45) * (0.25 + 1.2 * min(T, 1.5));

  if (u_vort > 0.0) {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    ivec2 sz = textureSize(u_curl, 0) - 1;
    float wl = abs(texelFetch(u_curl, clamp(ip - ivec2(1, 0), ivec2(0), sz), 0).r);
    float wr = abs(texelFetch(u_curl, clamp(ip + ivec2(1, 0), ivec2(0), sz), 0).r);
    float wb = abs(texelFetch(u_curl, clamp(ip - ivec2(0, 1), ivec2(0), sz), 0).r);
    float wt = abs(texelFetch(u_curl, clamp(ip + ivec2(0, 1), ivec2(0), sz), 0).r);
    float w = texelFetch(u_curl, ip, 0).r;
    vec2 g = vec2(wr - wl, wt - wb);
    vec2 n = g / (length(g) + 1e-5);
    va += u_dt * u_vort * u_texelH * vec2(n.y, -n.x) * w;
  }

  // Jets: a transient in a band drives the gas above that band's x upward, strongest at the base,
  // so a kick blasts a column up the centre and a hat flicks a lick at the edges.
  vec4 seed = texture(u_seed, vec2(v_uv.x, 0.5));
  float jet = seed.g;
  float reach = 1.0 - smoothstep(0.0, 0.75, v_uv.y);
  // Split into drifting tongues so a wide jet shoots up as spikes, not a flat-topped slab.
  float tongue = 0.25 + 1.6 * max(0.0, gnoise(vec3(v_uv.x * u_aspect * 11.0, u_time * 1.3, 11.0)) + 0.25);
  va.y += max(0.0, u_jetVel * jet * tongue - va.y) * reach * (1.0 - exp(-30.0 * u_dt));

  va *= exp(-u_damp * u_dt);

  // Flame speed = f(level): drive the column's upward speed toward its rise speed — hardest at the
  // base, still firm up top — so a loud frequency's gas races up and a quiet one's barely lifts.
  // After damping, so the column actually reaches its target; a jet can still push past it.
  if (u_rise > 0.0) {
    float hold = 1.0 - 0.6 * smoothstep(0.0, 0.95, v_uv.y);
    float target = max(seed.b, min(va.y, u_jetVel * jet));
    va.y += (target - va.y) * hold * (1.0 - exp(-u_rise * u_dt));
  }
  va = clamp(va, -4.0, 4.0);
  o = vec4(va * u_venc.x + u_venc.y, 0.0, 1.0);
}
