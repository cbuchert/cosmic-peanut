#version 300 es
// Upscale the reduced-resolution volume pass onto the frame (blended ONE, ONE_MINUS_SRC_ALPHA:
// the texture already holds premultiplied, tone-mapped colour).
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_vol;
void main() {
  o = texture(u_vol, v_uv);
}
