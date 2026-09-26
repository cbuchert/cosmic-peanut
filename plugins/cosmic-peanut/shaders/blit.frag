#version 300 es
// Soft lines: upscale the 1x ring buffer to the canvas with linear filtering (a slight glow).
precision mediump float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 o;
void main() {
  o = vec4(texture(uSrc, vUv).rgb, 1.0);
}
