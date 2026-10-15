#version 300 es
// Soft across the streak's width; drawn additively over the fire.
precision mediump float;
in vec4 v_col;
in float v_side;
out vec4 o;
void main() {
  o = v_col * (1.0 - v_side * v_side);
}
