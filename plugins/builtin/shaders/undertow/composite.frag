#version 300 es
// Feedback buffer -> screen: exposure, gentle tone map, vignette.
// The canvas is transparent and premultiplied: the colour is already "light on black", so keep it
// and let alpha = its brightest channel. Over black that is identical to an opaque canvas; over the
// desktop the rings glow on it with no dark box.
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform float u_exposure;
void main() {
  vec3 c = texture(u_src, v_uv).rgb * u_exposure;
  c = 1.0 - exp(-c);                       // soft shoulder, never clips hard
  vec2 d = v_uv - 0.5;
  c *= 1.0 - 0.55 * dot(d, d) * 2.0;       // vignette
  c = pow(c, vec3(0.9));
  o = vec4(c, max(c.r, max(c.g, c.b)));
}
