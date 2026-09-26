#version 300 es
// Everything you see is drawn here, once per pixel per frame. Save the file: the visualizer
// reloads in ~300 ms. Compile errors show in the overlay with the line number.
precision highp float;

uniform vec2 u_resolution;  // drawing-buffer pixels
uniform float u_time;       // seconds
uniform float u_bass;       // audio.bassAtt  (1.0 = average loudness for the band)
uniform float u_mid;        // audio.midAtt
uniform float u_treb;       // audio.trebAtt
uniform float u_beat;       // 1 on the beat, falling to 0 before the next (from audio.beatPhase)
uniform float u_flash;      // onset flash, already rate-limited when "Reduce flashing" is on
uniform float u_bands[64];  // audio.bands, 0–1, low to high
uniform vec3 u_color;       // the "color" param
uniform float u_intensity;  // the "intensity" param

out vec4 fragColor;

const float PI = 3.14159265;

void main() {
  // Centered coordinates, y from -0.5 to 0.5, square pixels.
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
  float r = length(p);
  float a = atan(p.y, p.x);

  // Pick a band by angle (lows on the left, highs on the right, mirrored top/bottom),
  // blending neighbours so the outline stays smooth.
  float f = (1.0 - abs(a) / PI) * 63.0;
  int i = int(f);
  float band = mix(u_bands[i], u_bands[min(i + 1, 63)], fract(f));

  // The halo: a thin ring whose radius follows the bass and the band under this angle.
  float radius = 0.2 + 0.04 * u_bass + 0.02 * u_beat + 0.12 * band;
  radius += 0.006 * u_mid * sin(a * 7.0 + u_time * 1.5);
  float ring = 0.0035 / abs(r - radius);

  vec3 col = u_color * ring * u_intensity;
  col += u_color * 0.35 * exp(-r * 4.0) * (0.4 + u_flash);   // soft core glow
  col += vec3(0.25, 0.35, 0.9) * 0.05 * u_treb * (1.0 - r);  // cool haze from the highs

  col = 1.0 - exp(-col);  // tone map: bright, never clipped

  // The canvas is TRANSPARENT and PREMULTIPLIED: the app draws black behind it, or the desktop
  // when "Transparent background" is on. Don't output alpha 1.0 (that paints a black box over the
  // desktop). `col` is light on black, i.e. already premultiplied, so use its brightest channel as
  // alpha: identical over black, glowing light over anything else.
  fragColor = vec4(col, max(col.r, max(col.g, col.b)));
}
