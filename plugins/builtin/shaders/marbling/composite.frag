#version 300 es
// Display: the baked inks pushed through the pending events (events.glsl, exact — no resampling
// blur), coloured: each ink its palette colour, paper (1 − total ink) cream, or clear when Paper
// is "none" (u_paper.a = 0). Premultiplied output for the transparent canvas. A flash-limited
// sheen lifts the page a little toward white on hits.
precision highp float;
out vec4 o;
#include sample.glsl
#include events.glsl

uniform vec2 u_size;       // canvas, px
uniform vec3 u_ink[4];
uniform vec4 u_paper;      // premultiplied
uniform float u_sheen;

void main() {
  vec2 px = gl_FragCoord.xy * (u_prevSize / u_size);
  vec4 w = clamp(marble(px / u_prevSize.y), 0.0, 1.0);
  float ink = min(1.0, w.x + w.y + w.z + w.w);
  vec3 c = w.x * u_ink[0] + w.y * u_ink[1] + w.z * u_ink[2] + w.w * u_ink[3];
  vec4 col = vec4(c, ink) + (1.0 - ink) * u_paper;
  col.rgb += (col.a - col.rgb) * (0.07 * u_sheen);
  o = col;
}
