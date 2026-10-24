#version 300 es
// Tessellations, cinematic Look: depth of field on the print (lib/tess-gl.js runs it on the 3D
// surfaces, between the print pass and the composite). A gather on the final colour with the
// circle of confusion the surface wrote to alpha (signed diameter in target px: near < 0 < far;
// look.glsl tessCoC), after the scatter-as-gather filters of Jimenez ("Next Generation Post
// Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014 Advances course) in its simplest
// form: each pixel gathers u_taps samples on a golden-angle spiral over its own blur disk; a
// sample counts where its own disk reaches this pixel, and a sample behind this pixel is clipped
// to this pixel's disk, so a sharp subject never smears into the blurred background behind it.
// The spiral turns per pixel (interleaved gradient noise), trading banding for a fixed grain the
// paper texture hides. In-focus pixels (disk under 1.5 px) read one tap.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_src;   // the print: linear colour, alpha = signed CoC (target px)
uniform vec2 u_texel;      // 1 / its size
uniform int u_taps;        // gather taps (lib/tess-look.js lookSamples dofTaps)

#define DOF_TAPS_MAX 32
#define GOLDEN 2.39996323

void main() {
  vec4 c0 = texture(u_src, v_uv);
  float r0 = 0.5 * abs(c0.a);
  if (r0 < 0.75) {
    o = vec4(c0.rgb, 1.0);
    return;
  }
  float rot = 6.28318530718 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 sum = c0.rgb;
  float wsum = 1.0;
  float n = float(u_taps);
  for (int i = 0; i < DOF_TAPS_MAX; i++) {
    if (i >= u_taps) break;
    float fi = float(i);
    float r = r0 * sqrt((fi + 0.5) / n);
    float a = fi * GOLDEN + rot;
    vec4 s = texture(u_src, v_uv + r * vec2(cos(a), sin(a)) * u_texel);
    float rs = 0.5 * abs(s.a);
    if (s.a > c0.a) rs = min(rs, r0);     // behind this pixel: it can't spill over it
    float w = clamp(rs - r + 1.0, 0.0, 1.0);
    sum += s.rgb * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 1.0);
}
