#version 300 es
// Tiled Torus displacement map: once a frame, the waves' displacement (stored units; the surface
// shader scales by amp) over the torus's parameters, u = θ / 2π across, v = age (laps round the
// tube from the hole) up, so the march reads it with one bilinear tap. Mirrors
// src/lib/torus-wave.js dispAt: column from θ (linear, wrapping), rows ago from the age (LAP rows
// a lap, gliding by the push fraction), linear between two rows; just past the hole the waves
// finishing their lap hand over to the newborn ones. Texel (i, j) holds θ = 2π i / W, age = j / H.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_wave; // R16F ring values, COLS × ROWS, rows circular
uniform vec3 u_wHist;     // head row, rows, push fraction
uniform vec2 u_wLap;      // rows per lap round the tube, hand-over stretch (fraction of a lap)
uniform vec2 u_size;      // this map's size

float waveAt(float r, float x) {
  float rows = u_wHist.y;
  float rr = clamp(r, 0.0, rows - 2.0);
  float r0 = floor(rr);
  float ra = mod(u_wHist.x - r0 + rows, rows);
  float rb = mod(u_wHist.x - r0 - 1.0 + rows, rows);
  float va = texture(u_wave, vec2(x, (ra + 0.5) / rows)).r;
  float vb = texture(u_wave, vec2(x, (rb + 0.5) / rows)).r;
  return mix(va, vb, rr - r0);
}

void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  float x = ij.x / u_size.x + 0.5 / float(textureSize(u_wave, 0).x);
  float age = ij.y / u_size.y;
  float r = age * u_wLap.x - u_wHist.z;
  float v = waveAt(r, x);
  if (age < u_wLap.y) v = mix(waveAt(r + u_wLap.x, x), v, smoothstep(0.0, 1.0, age / u_wLap.y));
  o = vec4(v, 0.0, 0.0, 1.0);
}
