#version 300 es
// Thick lines generated from gl_VertexID (6 vertices per segment): no vertex buffers at all.
// Audio arrives in a 512x2 R32F texture: row 0 = waveform, row 1 = the 64 bands.
precision highp float;
uniform highp sampler2D u_audio;
uniform vec2 u_res;
uniform float u_mode;     // 0 = rings, 1 = bars
uniform float u_radius;   // base radius, fraction of the short side
uniform float u_thick;    // line width in pixels
uniform float u_time;
out float v_edge;
out float v_level;

const int RING_SEGS = 256;
const float TAU = 6.28318530718;

float wave(int i) { return texelFetch(u_audio, ivec2(i & 511, 0), 0).r; }
float band(int i) { return texelFetch(u_audio, ivec2(clamp(i, 0, 63), 1), 0).r; }

// Point on ring `ring` at segment position s (0..RING_SEGS).
vec2 ringPoint(int ring, float s) {
  float a = s / float(RING_SEGS) * TAU + u_time * (ring == 0 ? 0.15 : -0.1);
  int i = int(s) % RING_SEGS;
  float r;
  if (ring == 0) {
    // Waveform ring; ends blended so the loop closes without a seam.
    float w = mix(wave(i * 2), wave((RING_SEGS - 1 - i) * 2), smoothstep(0.8, 1.0, s / float(RING_SEGS)));
    r = u_radius + w * 0.12;
  } else {
    // Spectrum ring, mirrored so lows sit at top and bottom.
    float f = abs(s / float(RING_SEGS) * 2.0 - 1.0) * 63.0;
    r = u_radius * 1.55 + band(int(f)) * 0.14;
  }
  return vec2(cos(a), sin(a)) * r;
}

void main() {
  int id = gl_VertexID;
  int seg = id / 6;
  int corner = id % 6;
  // Two triangles: (0,-) (1,-) (0,+) / (0,+) (1,-) (1,+)
  float t = (corner == 1 || corner == 4 || corner == 5) ? 1.0 : 0.0;
  float side = (corner == 2 || corner == 3 || corner == 5) ? 1.0 : -1.0;
  float shortSide = min(u_res.x, u_res.y);
  vec2 toNdc = shortSide / u_res;  // unit = half the short side
  vec2 p;
  vec2 n;
  float level;

  if (u_mode < 0.5) {
    int ring = seg / RING_SEGS;
    float s = float(seg % RING_SEGS);
    vec2 a = ringPoint(ring, s);
    vec2 b = ringPoint(ring, s + 1.0);
    vec2 d = normalize(b - a);
    n = vec2(-d.y, d.x);
    p = mix(a, b, t);
    level = ring == 0 ? 0.9 : 0.6;
  } else {
    // 128 radial spikes (64 bands mirrored).
    int k = seg;
    int b = k < 64 ? k : 127 - k;
    float lv = band(b);
    float ang = (float(k) + 0.5) / 128.0 * TAU + TAU * 0.25 + u_time * 0.1;
    vec2 dir = vec2(cos(ang), sin(ang));
    p = dir * (u_radius * 0.8 + t * (0.04 + lv * 0.45));
    n = vec2(-dir.y, dir.x);
    level = 0.4 + lv;
  }
  v_edge = side;
  v_level = level;
  float halfW = u_thick / shortSide;  // pixels -> units of half the short side
  gl_Position = vec4((p + n * side * halfW) * toNdc, 0.0, 1.0);
}
