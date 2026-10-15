#version 300 es
// Spark streaks (lib/sparks.js fill): clip position, premultiplied colour, side across the width.
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_col;
layout(location = 2) in float a_side;
out vec4 v_col;
out float v_side;
void main() {
  v_col = a_col;
  v_side = a_side;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
