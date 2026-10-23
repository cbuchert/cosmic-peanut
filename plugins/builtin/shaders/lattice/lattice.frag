#version 300 es
// Lattice family raymarch (reduced resolution), assembled by lib/structures.js assembleShader:
// shared declarations, then the structure (its scene SDF and surface parameterization), the
// sphere tracer, and the shading. README.md describes the seam; post.frag is the composite.
precision highp float;

in vec2 v_uv;
out vec4 o;

// #include common
// #include structure
// #include march
// #include shade

void main() {
  vec2 uv = (gl_FragCoord.xy / u_res) * 2.0 - 1.0;
  float aspect = u_res.x / u_res.y;
  vec3 rd = normalize(u_fwd + uv.x * aspect * u_tanHalf * u_right + uv.y * u_tanHalf * u_up);
  vec3 ro = u_cam;
  float t;
  int id;
  // Ran out of distance or steps: all fog (u_far sits where the fog is nearly opaque anyway).
  if (!march(ro, rd, t, id)) {
    o = vec4(u_bg * u_bgA, u_bgA);
    return;
  }
  o = shade(ro, rd, t, id);
}
