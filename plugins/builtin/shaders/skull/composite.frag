// Skull Trip: full-resolution op-art stripes with the skull layer over them.
// Prepended at load: #version, precision, the shape table and opart.glsl.

in vec2 v_uv;
out vec4 o_color;

uniform sampler2D u_skull; // premultiplied skull layer (possibly at reduced resolution)
uniform float u_circle;    // skull bounding circle radius, screen units (skip the fetch outside)

void main() {
  vec2 p = (v_uv * 2.0 - 1.0) * u_view;
  float s = opStripe(opPhase(p, true));
  // Premultiplied stripes: ink is opaque; paper has u_paperAlpha ("black only" → transparent).
  vec4 stripes = vec4(mix(u_ink, u_paper * u_paperAlpha, s), mix(1.0, u_paperAlpha, s));
  vec4 skull = length(p) < u_circle * 1.02 + 0.01 ? texture(u_skull, v_uv) : vec4(0.0);
  o_color = skull + (1.0 - skull.a) * stripes;
}
