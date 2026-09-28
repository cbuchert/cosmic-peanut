#version 300 es
// Water (full-res HDR) over soft mist (low-res, blurred) -> transparent, premultiplied canvas.
// Colour is "light on black", so alpha = its brightest channel: identical to opaque over black,
// and the water floats over a light desktop with no dark box or grey haze.
precision highp float;
in vec2 v_uv;
uniform sampler2D u_water;
uniform sampler2D u_mist;
uniform vec3 u_mistColor;
uniform float u_mistGain;
uniform float u_exposure;
out vec4 o;
void main() {
  vec3 water = texture(u_water, v_uv).rgb;
  float m = texture(u_mist, v_uv).r;
  vec3 c = water * u_exposure + u_mistColor * (m * u_mistGain);
  c = 1.0 - exp(-c);
  // Highlights bloom toward white where the water is densest.
  float l = max(c.r, max(c.g, c.b));
  c = mix(c, vec3(l), smoothstep(0.75, 1.0, l) * 0.5);
  // Cut the faintest residue so the canvas is truly clear away from the water.
  c = max(c - 0.004, 0.0) * (1.0 / 0.996);
  o = vec4(c, max(c.r, max(c.g, c.b)));
}
