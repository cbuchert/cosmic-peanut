#version 300 es
// Bake: push the ink texture through the pending events (events.glsl) into the other texture.
precision highp float;
out vec4 o;
#include sample.glsl
#include events.glsl

void main() {
  o = marble(gl_FragCoord.xy / u_prevSize.y);
}
