#version 300 es
// Dark Sun's painted backdrop: the sky (ash grey over salmon) and the ground (dark mauve) as
// watercolour washes - smooth, domain-warped fbm at low frequencies, drifting very slowly. No grain,
// no dots. Rendered at quarter resolution (the washes have no fine detail) and sampled, linearly
// filtered, by darksun.frag.
precision highp float;

out vec4 o;

uniform vec2 u_res;      // full drawing-buffer pixels
uniform vec2 u_scale;    // full pixels per backdrop texel
uniform float u_unit;    // min(w, h)
uniform float u_horizon; // px from the top
uniform float u_time;    // drift clock
uniform vec3 u_c[8];     // palette (see darksun.frag)

// #include noise

void main() {
  vec2 fc = gl_FragCoord.xy * u_scale;
  fc.y = u_res.y - fc.y;           // px, y down
  vec2 p = fc / u_unit;
  float hz = u_horizon;
  float t = u_time;
  vec3 SKY_TOP = u_c[0], SKY_LOW = u_c[1], GROUND = u_c[2], WASH = u_c[3], GLOW = u_c[4];
  vec3 bg;
  if (fc.y < hz) {
    float v = fc.y / hz;                                  // 0 top, 1 horizon
    float w1 = wash(p * vec2(1.1, 2.2) + vec2(0.0, 3.0), t * 0.02);
    float grad = smoothstep(0.2, 0.95, v + 0.3 * (w1 - 0.5));
    vec3 sky = mix(SKY_TOP * 0.85, SKY_TOP, smoothstep(0.0, 0.35, v));
    sky = mix(sky, SKY_LOW, grad);
    // Vertical brush streaks and broad blooms of pigment.
    float vs = fbm3(vec2(p.x * 7.0 + t * 0.01, p.y * 0.35));
    float bloom = wash(p * 0.8 + vec2(9.1, 2.4), -t * 0.015);
    sky *= 0.86 + 0.2 * vs + 0.3 * (bloom - 0.5);
    // Glow rising off the horizon.
    sky = mix(sky, mix(SKY_LOW, GLOW, 0.4), 0.35 * smoothstep(0.7, 1.0, v));
    bg = sky;
  } else {
    float g = (fc.y - hz) / max(u_res.y - hz, 1.0);       // 0 horizon, 1 bottom
    float w1 = wash(p * vec2(0.9, 2.6) + vec2(5.0, 0.0), t * 0.015);
    float w2 = wash(p * vec2(2.4, 0.6) + vec2(1.3, 8.0), -t * 0.01);
    vec3 ground = mix(WASH, GROUND, smoothstep(0.0, 0.35, g + 0.25 * (w1 - 0.5)));
    ground *= 0.85 + 0.5 * (w2 - 0.5) + 0.4 * (w1 - 0.5);
    // Faint horizontal strata near the horizon.
    float strata = fbm3(vec2(p.x * 0.8, p.y * 40.0 + 2.0));
    ground += (strata - 0.5) * 0.06 * (1.0 - smoothstep(0.0, 0.3, g)) * WASH;
    bg = ground;
  }
  o = vec4(bg, 1.0);
}
