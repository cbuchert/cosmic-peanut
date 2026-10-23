#version 300 es
// Metamorphosis, flat surface: the tiling fills the screen and drifts. The plane point is the
// pixel scaled and turned; S (dp/dpixel) is that scale and turn. Everything else is the engine.
precision highp float;

in vec2 v_uv;
out vec4 o;

#define TESS_ATLAS
// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec2 u_O;       // plane point at the centre of the view
uniform vec2 u_rot;     // view rotation (cos, sin)
uniform float u_zoom;   // plane units per half the short side

void main() {
  float hs = 0.5 * min(u_res.x, u_res.y);
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / hs;
  mat2 R = mat2(u_rot.x, u_rot.y, -u_rot.y, u_rot.x);
  o = tessShade(u_O + R * s * u_zoom, R * (u_zoom / hs));
}
