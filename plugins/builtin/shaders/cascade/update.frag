#version 300 es
// One fixed sim step for every particle (one texel each). Two float state textures in, two out:
//   s0 = (x, y, vx, vy)            position in height units (y: 0 bottom .. 1 top, x centred), velocity per s
//   s1 = (age, kind, weight, life)  kind 0 = dead (waiting at the lip), 1 = falling water, 2 = spray
// Dead particles respawn at the lip with probability u_spawn per step; *where* comes from the
// seed's inverse CDF (one uniform draw, two texelFetches, linear interpolation — the same maths as
// sampleInverse() in src/lib/cascade.js), and the initial speed follows the seed at that spot.
precision highp float;
precision highp int;
uniform highp sampler2D u_s0;
uniform highp sampler2D u_s1;
uniform highp sampler2D u_seed;   // SEED_N x 1, R32F: flow strength across the lip
uniform highp sampler2D u_inv;    // INV_N x 1, R32F: inverse CDF of the seed
uniform int u_count;
uniform uint u_step;
uniform float u_dt;
uniform float u_time;
uniform float u_spawn;     // respawn probability per step for a dead particle
uniform float u_gravity;   // height units / s^2
uniform float u_turb;      // lateral turbulence strength
uniform float u_spray;     // 0-1: chance and energy of splashing back up
uniform float u_pulse;     // 0-1 onset pulse (flash-limited)
uniform float u_lipY;
uniform float u_lipHalf;
uniform float u_poolY;
uniform float u_halfW;     // half the screen width in height units
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float rnd(inout uint s) { s = hash(s); return float(s >> 8) * (1.0 / 16777216.0); }

float seedAt(float x) {
  int n = textureSize(u_seed, 0).x;
  return texelFetch(u_seed, ivec2(clamp(int(x * float(n)), 0, n - 1), 0), 0).r;
}

// Smooth pseudo-noise from a few sines: cheap, continuous, drifts with time.
float wobble(vec2 p, float t) {
  return sin(p.y * 9.0 + t * 1.7 + sin(p.x * 5.0 + t * 0.6) * 1.8) * 0.6
       + sin(p.y * 23.0 - t * 2.9 + p.x * 11.0) * 0.4;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  int w = textureSize(u_s0, 0).x;
  int id = ij.y * w + ij.x;
  vec4 s0 = texelFetch(u_s0, ij, 0);
  vec4 s1 = texelFetch(u_s1, ij, 0);
  if (id >= u_count) { o0 = s0; o1 = s1; return; }
  uint seed = hash(uint(id) * 747796405u + u_step * 2891336453u);
  vec2 p = s0.xy;
  vec2 v = s0.zw;
  float age = s1.x, kind = s1.y, wt = s1.z, life = s1.w;

  if (kind < 0.5) {
    if (rnd(seed) < u_spawn) {
      // Inverse-CDF draw of the lip position.
      int m = textureSize(u_inv, 0).x;
      float q = rnd(seed) * float(m - 1);
      int j = int(q);
      float a = texelFetch(u_inv, ivec2(j, 0), 0).r;
      float b = texelFetch(u_inv, ivec2(min(j + 1, m - 1), 0), 0).r;
      float xs = mix(a, b, q - float(j));
      float s = seedAt(xs);
      float strong = clamp(s, 0.0, 1.6);
      p = vec2((xs * 2.0 - 1.0) * u_lipHalf, u_lipY + rnd(seed) * 0.012);
      // Heavier flow leaves the lip faster, and fans out slightly away from the centre.
      float down = 0.06 + 0.42 * strong + 0.25 * u_pulse + 0.05 * rnd(seed);
      float out_ = (xs * 2.0 - 1.0) * 0.05 * (0.4 + strong) + (rnd(seed) - 0.5) * 0.012 * (0.3 + strong);
      v = vec2(out_, -down);
      age = 0.0;
      kind = 1.0;
      wt = clamp(0.25 + 0.75 * strong, 0.0, 1.5) * (0.8 + 0.4 * rnd(seed));
      life = 0.0;
    }
  } else if (kind < 1.5) {
    age += u_dt;
    v.y -= u_gravity * u_dt;
    v.x += u_turb * wobble(p, u_time + float(id & 7)) * 0.35 * u_dt;
    v *= exp(-0.12 * u_dt);
    p += v * u_dt;
    if (p.y < u_poolY) {
      if (rnd(seed) < u_spray * 0.85) {
        // Impact: splash back up with random velocity, strong drag, short life, dimmer.
        float impact = length(v);
        float ang = (rnd(seed) - 0.5) * 2.4;
        float sp = impact * (0.2 + 0.6 * rnd(seed) * rnd(seed) + 0.2 * rnd(seed)) * (0.35 + 0.65 * u_spray);
        v = vec2(sin(ang) * sp * 1.3, cos(ang) * sp);
        p.y = u_poolY + 0.002;
        age = 0.0;
        kind = 2.0;
        life = 0.35 + 0.9 * rnd(seed);
        wt *= 0.55;
      } else {
        kind = 0.0;
      }
    }
  } else {
    age += u_dt;
    v.y -= u_gravity * 0.7 * u_dt;
    v.x += u_turb * wobble(p * 0.5, u_time) * 0.2 * u_dt;
    v *= exp(-2.6 * u_dt);
    p += v * u_dt;
    if (age > life || p.y < u_poolY - 0.04) kind = 0.0;
  }
  if (abs(p.x) > u_halfW + 0.05 || p.y < -0.05) kind = 0.0;
  if (kind < 0.5) { p = vec2(0.0, -2.0); v = vec2(0.0); }
  o0 = vec4(p, v);
  o1 = vec4(age, kind, wt, life);
}
