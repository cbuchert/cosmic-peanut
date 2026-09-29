#version 300 es
// Vorticity (z of curl) of the velocity field, 1/s, for vorticity confinement.
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
// #include common
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float w = (velAt(u_vel, p + ivec2(1, 0)).y - velAt(u_vel, p - ivec2(1, 0)).y) -
            (velAt(u_vel, p + ivec2(0, 1)).x - velAt(u_vel, p - ivec2(0, 1)).x);
  o = vec4(0.5 * w / (u_texel.y * u_L.y), 0.0, 0.0, 1.0);
}
