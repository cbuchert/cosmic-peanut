#version 300 es
// Divergence of the velocity field in texel units (grid spacing cancels in the solve), with the
// boundaries: inflow at the left, the sphere's own velocity for solid neighbours.
precision highp float;
out vec4 o;
uniform sampler2D u_vel;
// #include common
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = velAt(u_vel, p + ivec2(1, 0)).x - velAt(u_vel, p - ivec2(1, 0)).x +
            velAt(u_vel, p + ivec2(0, 1)).y - velAt(u_vel, p - ivec2(0, 1)).y;
  o = vec4(0.5 * d, 0.0, 0.0, 1.0);
}
