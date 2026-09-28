#version 300 es
// Temperature → colour on the transparent canvas. The low-res field is upscaled with linear
// filtering, its lookup nudged by fine noise so edges lick at full resolution, mapped through the
// palette ramp (premultiplied, alpha = brightest channel), plus a soft glow around hot parts.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_scal;
uniform sampler2D u_lut;    // 256×1 premultiplied ramp
uniform vec2 u_simTexel;
uniform float u_aspect;     // canvas width / height
uniform float u_time;
uniform float u_exposure;
uniform float u_glow;
// #include noise

float heat(vec2 uv) { return texture(u_scal, uv).r; }

void main() {
  vec2 p = v_uv * vec2(u_aspect, 1.0);
  vec2 d = vec2(gnoise(vec3(p * 38.0 - vec2(0.0, u_time * 3.0), u_time)),
                gnoise(vec3(p * 38.0 + 17.0 - vec2(0.0, u_time * 3.0), u_time))) * u_simTexel * 1.6;
  float T = heat(v_uv + d);

  // Glow: two rings of taps on the low-res field (cheap: it is small and cached).
  float g = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + 0.3;
    vec2 dir = vec2(cos(a), sin(a)) * u_simTexel;
    g += heat(v_uv + dir * 4.0) + heat(v_uv + dir * 10.0);
  }
  g /= 16.0;

  float t = 1.0 - exp(-T * u_exposure * 1.1);
  vec4 c = texture(u_lut, vec2(t, 0.5));
  float gt = 1.0 - exp(-g * u_exposure * 0.9);
  vec4 gc = texture(u_lut, vec2(gt * 0.85, 0.5)) * (0.55 * u_glow);
  vec3 col = min(c.rgb + gc.rgb * (1.0 - 0.5 * c.a), 1.0);
  o = vec4(col, max(col.r, max(col.g, col.b)));
}
