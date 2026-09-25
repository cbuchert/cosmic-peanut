#version 300 es
// MilkDrop-style feedback: sample last frame through a zoom/rotate/ripple warp, then decay.
precision highp float;
in vec2 v_uv;
out vec4 o;

uniform sampler2D u_prev;
uniform vec2 u_res;       // target size in pixels
uniform float u_time;     // speed-scaled seconds
uniform float u_zoom;     // < 1 pulls the image outward (per 60 Hz frame, pre-scaled by dt)
uniform float u_rot;      // radians this frame
uniform float u_warp;     // ripple strength (mid)
uniform float u_decay;    // brightness kept this frame
uniform float u_mirror;   // 1 = left/right symmetric
uniform vec3 u_tint;
uniform float u_hue;      // hue rotation this frame (radians), so trails change colour as they age

vec3 hueRotate(vec3 c, float a) {
  // Rotate chroma in YIQ space.
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toYiq * c;
  float cs = cos(a), sn = sin(a);
  y.yz = vec2(y.y * cs - y.z * sn, y.y * sn + y.z * cs);
  return max(toRgb * y, 0.0);
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec2 p = v_uv - 0.5;
  p.x *= aspect;
  if (u_mirror > 0.5) p.x = abs(p.x);

  float r = length(p);
  float a = atan(p.y, p.x);
  // Radial breathing: rings near the centre move faster than the edges.
  r *= u_zoom + 0.006 * u_warp * sin(r * 22.0 - u_time * 2.3);
  a += u_rot * (1.2 - r) + 0.01 * u_warp * sin(r * 9.0 + u_time * 0.7);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q += 0.0025 * u_warp * vec2(sin(p.y * 11.0 + u_time * 1.3), cos(p.x * 9.0 - u_time * 1.1));
  q.x /= aspect;
  vec2 uv = q + 0.5;

  // Two taps smooth the resampling so trails soften instead of aliasing.
  vec2 px = 0.5 / u_res;
  vec3 c = 0.5 * (texture(u_prev, uv + px).rgb + texture(u_prev, uv - px).rgb);
  // Trails drift through the hues and are pulled gently back toward the tint.
  c = hueRotate(c, u_hue);
  c = mix(c, dot(c, vec3(0.333)) * u_tint * 1.3, 0.02);
  c *= 1.0 + 0.012 * (u_tint - 0.5);  // saturate toward the tint a touch
  o = vec4(c * u_decay, 1.0);
}
