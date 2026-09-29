// Shared by Laminar's sim passes, spliced in where a shader says `// #include common`.
// The sim runs in the flow's own frame: +x downstream (inflow at the left edge, outflow at the
// right), positions in screen heights. Velocities are screen heights per second.
uniform vec2 u_L;        // grid extent, screen heights
uniform vec2 u_texel;    // 1 / grid size (texels)
uniform vec3 u_ball;     // sphere: centre (sim frame, heights), radius
uniform vec3 u_ballVel;  // its velocity, and dR/dt
uniform float u_U;       // inflow speed

vec2 posOf(ivec2 q) { return (vec2(q) + 0.5) * u_texel * u_L; }

bool solid(vec2 p) {
  vec2 d = p - u_ball.xy;
  return dot(d, d) < u_ball.z * u_ball.z;
}

// The solid-boundary rule (mirrored and tested in src/lib/flow.js obstacleVelocity): fluid inside
// the sphere moves with it, and a growing sphere pushes it outward in proportion to the distance
// from the centre.
vec2 solidVel(vec2 p) {
  vec2 d = p - u_ball.xy;
  return u_ballVel.xy + (u_ball.z > 0.0 ? u_ballVel.z / u_ball.z : 0.0) * d;
}

// Velocity at texel q with the boundaries applied: the inflow ghost column is the inflow, solid
// cells move with the sphere, other edges clamp.
vec2 velAt(sampler2D v, ivec2 q) {
  if (q.x < 0) return vec2(u_U, 0.0);
  ivec2 s = textureSize(v, 0);
  vec2 p = posOf(q);
  if (solid(p)) return solidVel(p);
  return texelFetch(v, clamp(q, ivec2(0), s - 1), 0).xy;
}
