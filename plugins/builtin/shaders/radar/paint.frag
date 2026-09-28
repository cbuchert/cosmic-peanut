#version 300 es
// Polar phosphor update. The texture is bearing (x, 0 = north, clockwise, one turn) × radius
// (y, 0 = center, 1 = rim). Every texel decays by u_decay (fixed-timestep, from lib/radar.js);
// texels inside the wedge the arm swept since last frame, [u_start, u_start + u_span), are
// rewritten with this frame's return: the band profile at that radius (with a little speckle, as
// real returns have) plus ground clutter from the waveform near the center.
precision highp float;
out vec4 o;
uniform sampler2D u_prev;
uniform sampler2D u_profile; // R32F, width = phosphor height: row 0 spectrum, row 1 clutter
uniform float u_decay;
uniform float u_start;
uniform float u_span;
uniform float u_seed;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_prev, px, 0).r * u_decay;
  float bearing = gl_FragCoord.x / float(textureSize(u_prev, 0).x);
  float d = bearing - u_start;
  if (u_span >= 1.0 || d - floor(d) < u_span) {  // lib/radar.js inWedge
    float sig = texelFetch(u_profile, ivec2(px.y, 0), 0).r;
    float clutter = texelFetch(u_profile, ivec2(px.y, 1), 0).r;
    float n = hash(vec2(px) + u_seed);
    float n2 = hash(vec2(px.y, px.x) * 1.7 + u_seed * 0.37);
    v = sig * (0.72 + 0.56 * n) + clutter * smoothstep(0.62, 1.0, n2) * 2.2;
  }
  o = vec4(v, 0.0, 0.0, 1.0);
}
