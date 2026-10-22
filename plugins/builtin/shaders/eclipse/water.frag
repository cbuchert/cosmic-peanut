#version 300 es
// Eclipse's water: above the waterline, the scene (eclipse.frag, rendered to u_scene) as it is;
// below, a dark sea mirroring it. The mirror is displaced by the gradient of a height field on the
// water plane — small ripples kept running by the waveform, long rolling swells from the bass,
// rings spreading from where beats drop — darker toward the viewer (Fresnel-ish), and the sun's
// reflection stretches into a vertical streak whose length follows the bass.
// Water-plane coordinates: depth z = H / (px below the waterline) (1 at the bottom edge, ∞ at
// the waterline); across, x = (px from centre) / H · z, with H = the waterline's height in px.
precision highp float;

uniform sampler2D u_scene; // the scene, premultiplied, canvas-sized
uniform sampler2D u_lev;   // 256 × 3: row 1 = the waveform around the ring (−1..1)
uniform vec2 u_res;        // canvas px
uniform float u_horizon;   // waterline, px from the bottom
uniform float u_cx;        // the eclipse's centre, px
uniform float u_ringR;     // the ring's outer radius, px
uniform float u_chop;      // small ripples 0–1 (createWater)
uniform float u_swell;     // bass swell 0–1
uniform float u_roll;      // swell phase, periods
uniform float u_streak;    // the streak's length 0–1 (flash-limited)
uniform float u_time;      // drift clock, s
uniform vec4 u_rings[4];   // (x, z, radius, amplitude)
uniform vec3 u_gamma;      // tint
uniform float u_sky;       // 1 = opaque, 0 = black is transparent

out vec4 outColor;

const float TAU = 6.28318531;

// A wave's gradient, faded out where its screen frequency nears the pixel grid (no shimmer).
// k = wavenumber in plane units, ppu = px per plane unit along the wave's direction.
float aa(float k, float ppu) {
  return 1.0 - smoothstep(0.12, 0.35, k / (TAU * ppu));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  if (fc.y >= u_horizon) {
    outColor = texelFetch(u_scene, ivec2(fc), 0);
    return;
  }
  float H = u_horizon;
  float dpx = H - fc.y;            // px below the waterline
  float s = dpx / H;               // 0 at the waterline … 1 at the bottom edge
  float z = 1.0 / max(s, 1e-3);
  float x = (fc.x - u_cx) / H * z;
  float ppz = H / (z * z);          // px per unit of depth here
  float ppx = H / z;                // px per unit across

  // Height-field gradient (d/dx, d/dz).
  vec2 g = vec2(0.0);
  // Long swells rolling in toward the viewer (bass).
  float ks = 1.6;
  float ph = ks * z - TAU * u_roll + 0.4 * sin(0.7 * x);
  g += (0.015 + 0.08 * u_swell) * ks * cos(ph) * vec2(0.28 * cos(0.7 * x), 1.0) * aa(ks, ppz);
  // Small ripples: a few crossing wave trains, their height shaped by the waveform.
  float wv = texture(u_lev, vec2(fract(x * 0.07 + 0.5), 1.5 / 3.0)).r;
  float ca = (0.002 + 0.012 * u_chop) * (0.7 + 0.9 * abs(wv));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 d = normalize(vec2(sin(1.9 * fi + 0.6), 1.0));
    float k = 7.0 + 4.0 * fi;
    float ppu = 1.0 / length(d / vec2(ppx, ppz));
    float a = dot(d, vec2(x, z)) * k - u_time * (2.2 + 0.8 * fi) + 2.1 * fi;
    g += ca * k * cos(a) * d * aa(k, ppu);
  }
  // Beat rings spreading over the surface.
  for (int i = 0; i < 4; i++) {
    vec4 rg = u_rings[i];
    vec2 o = vec2(x, z) - rg.xy;
    float dist = length(o);
    float u = (dist - rg.z) / 0.3;
    float kr = 10.0;
    float ppu = 1.0 / length(o / max(dist, 1e-4) / vec2(ppx, ppz));
    g += rg.w * 0.045 * kr * exp(-u * u) * cos((dist - rg.z) * kr) * o / max(dist, 1e-4) * aa(kr, ppu);
  }

  // The streak: inside a column under the sun the mirror stretches toward the viewer.
  float colw = u_ringR * (0.55 + 0.6 * s);
  float col = exp(-pow((fc.x - u_cx) / colw, 2.0));
  float stretch = 1.0 + 1.6 * u_streak * col;

  // Mirror (displaced; the displacement grows toward the viewer, like perspective).
  vec2 disp = vec2(g.x * 0.5, g.y) * s * H * 0.22;
  float sy = H + dpx / stretch + disp.y;
  vec2 st = vec2(fc.x + disp.x, max(sy, H + 1.0)) / u_res;
  vec4 refl = texture(u_scene, st);
  float fres = mix(0.62, 0.22, smoothstep(0.0, 1.0, s));
  vec3 colr = refl.rgb * fres;

  // Glints along the streak: horizontal bands where the swells tilt toward the sun.
  float band = 0.5 + 0.5 * sin(ph * 2.0 + 3.0 * g.y);
  float glint = smoothstep(0.55, 0.95, band) * aa(2.0 * ks, ppz);
  float len = 0.08 + 0.9 * u_streak;
  float streak = col * glint * exp(-s / len) * (0.05 + 0.3 * u_streak);
  colr += pow(vec3(streak), u_gamma);

  colr = clamp(colr, 0.0, 1.0);
  float a = mix(max(colr.r, max(colr.g, colr.b)), 1.0, u_sky);
  outColor = vec4(colr, a);
}
