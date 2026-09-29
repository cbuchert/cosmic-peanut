#version 300 es
// Resize: carry the paint onto a texture of the new size — centred, never stretched (a narrower
// page crops the sides, a wider one scales the paint up by k). Mirrors toOldPage in
// src/lib/marbling.js.
precision highp float;
out vec4 o;
#include sample.glsl

uniform vec2 u_size;   // new size, texels
uniform vec4 u_map;    // (k, old centre x, old centre y, unused)
uniform vec2 u_newC;   // new centre, page units

void main() {
  vec2 p = gl_FragCoord.xy / u_size.y;
  vec2 old = (p - u_newC) / u_map.x + u_map.yz;
  o = sampleInk(old * u_prevSize.y);
}
