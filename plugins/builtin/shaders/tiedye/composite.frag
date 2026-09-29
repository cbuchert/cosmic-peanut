#version 300 es
// Tie-Dye composite: upsample the dye pass and weave it into cotton at full resolution.
// Input is linear, premultiplied; output is premultiplied sRGB for the transparent canvas.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform sampler2D u_dye;
uniform int u_fabric;

// Cheap value hash for thread slubs.
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec4 c = texture(u_dye, v_uv);
  vec2 frag = gl_FragCoord.xy;
  // Plain weave: warp and weft threads a few pixels wide, over-under, with uneven (slubby) threads.
  float slubX = hash(vec2(floor(frag.x / 3.3), 1.0));
  float slubY = hash(vec2(floor(frag.y / 3.3), 7.0));
  float wx = sin(frag.x * 1.9);
  float wy = sin(frag.y * 1.9);
  float over = step(0.0, wx * wy);
  float weave = mix(abs(wy) * (0.85 + 0.3 * slubY), abs(wx) * (0.85 + 0.3 * slubX), over);
  // Weave shading plus a little per-pixel fibre grain.
  float light = 0.92 + 0.12 * weave + 0.03 * (hash(frag) - 0.5);
  if (c.a <= 0.0) {
    o = vec4(0.0);
    return;
  }
  vec3 lin = c.rgb / c.a * light;
  float a = u_fabric == 0 ? 1.0 : c.a * (0.93 + 0.07 * weave);
  o = vec4(pow(lin, vec3(1.0 / 2.2)) * a, a);
}
