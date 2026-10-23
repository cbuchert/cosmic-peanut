#version 300 es
// Lattice composite: upsample the raymarch pass (linear, premultiplied) onto the canvas as
// premultiplied sRGB, with a little dither so the fog's gradients don't band.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_scene;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec4 c = texture(u_scene, v_uv);
  if (c.a <= 1e-4) {
    o = vec4(0.0);
    return;
  }
  vec3 srgb = pow(clamp(c.rgb / c.a, 0.0, 1.0), vec3(1.0 / 2.2));
  srgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(srgb * c.a, c.a);
}
