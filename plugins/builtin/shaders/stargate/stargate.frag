#version 300 es
// Stargate: two infinite planes of slit-scan light, rolled about the direction of travel.
//
// Per pixel: turn the screen point back by the roll, cast the ray (x, y, 1) to the plane y = ±1 it
// points at (depth z = 1/|y|, lateral u = x·z; src/lib/stargate-view.js mirrors this and is
// tested), map the depth to a history row age (newest at the far end, rows glide toward the eye
// with u_frac), and read the waveform history there with a short smear along depth.
// Output is premultiplied light on black with alpha = its brightest channel (transparent canvas).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_hist;  // W x N RGBA: signed wave, streak, hue, energy
uniform vec2 u_res;        // drawing-buffer pixels
uniform float u_roll;      // radians
uniform float u_spread;    // field-of-view scale of the screen coordinate
uniform float u_head;      // ring row of the newest row
uniform float u_rows;      // N
uniform float u_frac;      // push clock leftover, 0-1
uniform float u_zfar;      // depth where the newest row enters
uniform float u_znear;     // depth of the oldest row
uniform float u_lane;      // texture widths per unit of lateral distance
uniform float u_texw;      // W
uniform float u_smear;     // smear length along depth, in rows
uniform float u_time;      // palette drift clock
uniform float u_bright;    // brightness (param x flash-limited pulse)
uniform float u_solar;     // 0-1 colour inversion
uniform vec3 u_glow;       // horizon glow colour x level
uniform vec3 u_pa, u_pb, u_pc, u_pd;

const float TAU = 6.2831853;

vec3 pal(float t) { return u_pa + u_pb * cos(TAU * (u_pc * t + u_pd)); }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * u_res.y) * u_spread;
  float c = cos(u_roll);
  float s = sin(u_roll);
  vec2 q = vec2(c * p.x + s * p.y, c * p.y - s * p.x);  // camera frame
  float ay = max(abs(q.y), 1e-5);
  float side = q.y >= 0.0 ? 1.0 : -1.0;
  float z = 1.0 / ay;
  float u = q.x * z;

  float rowDepth = (u_zfar - u_znear) / u_rows;
  float age = (u_zfar - z) / rowDepth - u_frac;
  // The lower plane reads the history from another lane offset so the planes aren't mirror images.
  float sx = u * u_lane + (side > 0.0 ? 0.0 : 0.37);

  // Lateral footprint of one pixel in texels: past ~1 the lanes alias, so fade them to their mean.
  float foot = z * (2.0 * u_spread / u_res.y) * u_lane * u_texw;
  float detail = clamp(1.6 - foot, 0.0, 1.0);

  // Slit-scan smear: 4 taps along depth, toward older (nearer) rows, weighted to the leading edge.
  float lum = 0.0;
  float core = 0.0;
  float hue = 0.0;
  float energy = 0.0;
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float a = age + fk * u_smear * 0.3333;
    float w = (1.0 - 0.22 * fk) * step(0.0, a) * step(a, u_rows - 1.5);
    vec4 t = texture(u_hist, vec2(sx, fract((u_head - a + 0.5) / u_rows)));
    float streak = t.g;
    float lane = mix(0.2, streak * streak * streak, detail) + 0.45 * detail * pow(max(t.r, 0.0), 4.0);
    lum += w * lane;
    core += w * pow(streak, 8.0) * detail;
    hue += w * t.b;
    energy += w * t.a;
    wsum += w;
  }
  float inv = wsum > 0.0 ? 1.0 / wsum : 0.0;
  lum *= inv;
  core *= inv;
  hue *= inv;
  energy *= inv;

  // Fade into the horizon (rows get sub-pixel there) and in from the ring's far end.
  float far = smoothstep(u_zfar, u_zfar * 0.7, z);
  float gain = (0.35 + 3.0 * energy) * far;

  float t = hue * 1.7 + 0.3 * side + 0.22 * sin(sx * 4.0) + 0.1 * sin(sx * 23.0) + u_time;
  vec3 col = pal(t) * lum * gain * 2.2 + vec3(core * gain * 0.9);

  // Horizon glow: a thin hot line and a wide halo, in the colour of the newest music.
  col += u_glow * (0.9 * exp(-ay * 60.0) + 0.3 * exp(-ay * 14.0));

  // Hold back the centre a little so the vanishing line glows without clipping.
  col *= 0.6 + 0.4 * smoothstep(0.0, 0.7, length(p));

  // Solarized moments: complement the hue, keep the brightness (no white flash).
  float mx = max(col.r, max(col.g, col.b));
  float mn = min(col.r, min(col.g, col.b));
  col = mix(col, vec3(mx + mn) - col, u_solar);

  col = 1.0 - exp(-col * u_bright);
  o = vec4(col, max(col.r, max(col.g, col.b)));
}
