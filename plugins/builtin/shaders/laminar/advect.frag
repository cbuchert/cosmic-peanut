#version 300 es
// One semi-Lagrangian advection of the velocity and scalar fields (both render targets at once),
// used twice per step for MacCormack: forward (u_dt > 0, sampling the state) and backward
// (u_dt < 0, sampling the forward result). Always carried by the state's velocity u_vel.
// Scalars: r = ψ, the line coordinate's displacement φ − y (so ψ' = ψ(x_b) + y_b − y),
// g = trail dye, b = dye × age. See src/lib/flow.js advectLines for the tested CPU reference.
precision highp float;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
uniform sampler2D u_vel;  // carrying velocity
uniform sampler2D u_fv;   // velocity being advected
uniform sampler2D u_fs;   // scalars being advected
uniform float u_dt;       // signed sim seconds
// #include common

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(q) + 0.5) * u_texel;
  vec2 v = texelFetch(u_vel, q, 0).xy;
  vec2 back = uv - u_dt * v / u_L;
  float shift = (back.y - uv.y) * u_L.y; // y_b − y
  vec4 fv = texture(u_fv, back);
  vec4 fs = texture(u_fs, back);
  fs.r += shift;
  // Came in through the inflow: fresh fluid, a fresh straight line (φ = y_b), no dye.
  if (back.x < 0.5 * u_texel.x || q.x == 0) {
    fv = vec4(u_U, 0.0, 0.0, 0.0);
    fs = vec4(shift, 0.0, 0.0, 0.0);
  }
  oV = fv;
  oS = fs;
}
