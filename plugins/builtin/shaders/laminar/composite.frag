#version 300 es
// Laminar's picture, at full canvas resolution. Each pixel is rotated into the sim frame and the
// line coordinate φ = y + ψ is read with a cubic B-spline filter from the coarse sim, so the lines
// themselves — contours φ·k = n + ½, box-filtered over the pixel (src/lib/flow.js lineCoverage)
// — stay razor-sharp at any sim size. Each line is shaded as a raised, slightly metallic ridge
// (its cross-section a half-cylinder lit from the upper left), the trail dye is laid over them
// through a red → orange ramp by age, and a chrome sphere (analytic, orthographic) reflects the
// line field and a studio environment. Output is premultiplied; the gaps are transparent with
// backdrop "none".
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_scal;
uniform vec2 u_simSize;   // grid size, texels
uniform vec2 u_L;         // grid extent, screen heights
uniform float u_aspect;   // canvas width / height
uniform vec2 u_dir;       // flow direction on screen (unit, y up)
uniform vec3 u_ball;      // sphere on screen: centre (heights, y up), radius
uniform vec3 u_ballSim;   // sphere in the sim frame (for the analytic fallback)
uniform float u_k;        // lines per screen height
uniform float u_px;       // one canvas pixel, in screen heights
uniform vec3 u_line;
uniform vec3 u_hi;
uniform vec3 u_shadow;
uniform vec3 u_gap;
uniform vec3 u_hot;
uniform vec3 u_warm;
uniform vec3 u_old;
uniform float u_gapA;     // 1 = gaps painted (black backdrop), 0 = transparent
uniform float u_trail;    // 0 / 1
uniform float u_trailOld; // s
uniform float u_glow;     // global brightness (flash-limited)
uniform float u_analytic; // 1 = no sim (RGBA8 fallback): potential flow around the sphere

const float DUTY = 0.56;  // = LINE_DUTY in src/lib/flow.js
const float E0 = 0.5 - 0.5 * DUTY;
const vec3 LIGHT = vec3(-0.46, 0.56, 0.69); // from the upper left, towards the viewer

// Cubic B-spline filter from four bilinear taps (smooth, no ringing, C2 between texels).
vec4 cubic(vec2 uv) {
  vec2 p = uv * u_simSize - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / u_simSize;
  vec2 h1 = (i + 1.5 + w3 / g1) / u_simSize;
  return g0.y * (g0.x * texture(u_scal, vec2(h0.x, h0.y)) + g1.x * texture(u_scal, vec2(h1.x, h0.y))) +
         g1.y * (g0.x * texture(u_scal, vec2(h0.x, h1.y)) + g1.x * texture(u_scal, vec2(h1.x, h1.y)));
}

// Screen (heights, y up) → sim frame (heights).
vec2 toSim(vec2 s) {
  vec2 q = s - vec2(0.5 * u_aspect, 0.5);
  return vec2(dot(q, u_dir), dot(q, vec2(-u_dir.y, u_dir.x))) + 0.5 * u_L;
}

// The flow's state at screen point s: x = φ·k, dye, age.
vec3 field(vec2 s) {
  vec2 P = toSim(s);
  if (u_analytic > 0.5) {
    vec2 r = P - u_ballSim.xy;
    float R2 = u_ballSim.z * u_ballSim.z;
    float phi = u_ballSim.y + r.y * max(0.0, 1.0 - R2 / max(dot(r, r), R2));
    return vec3(phi * u_k, 0.0, 0.0);
  }
  vec4 S = cubic(P / u_L);
  return vec3((P.y + S.r) * u_k, S.g, S.b / max(S.g, 1e-3));
}

float pulseInt(float x) {
  return floor(x) * DUTY + clamp(fract(x) - E0, 0.0, DUTY);
}

vec3 trailRamp(float age) {
  float u = clamp(age / u_trailOld, 0.0, 1.0);
  return u < 0.5 ? mix(u_hot, u_warm, u * 2.0) : mix(u_warm, u_old, u * 2.0 - 1.0);
}

// Lines + trail at one point: premultiplied colour with coverage alpha (gaps not included).
// x = φ·k, gx = its gradient per pixel (for the filter width and the ridge orientation).
vec4 surface(vec3 f, vec2 gx, out float trailA) {
  float x = f.x;
  float w = max(length(gx), 1e-4);
  float h = 0.5 * w;
  float cov = clamp((pulseInt(x + h) - pulseInt(x - h)) / w, 0.0, 1.0);
  // Ridge: across the line u ∈ [−1, 1]; normal tilts along the φ gradient.
  float u = clamp((fract(x) - 0.5) / (0.5 * DUTY), -1.0, 1.0);
  vec2 g = gx / w;
  vec3 N = vec3(u * g, sqrt(max(0.0, 1.0 - u * u)));
  float diff = max(dot(N, LIGHT), 0.0);
  float spec = pow(max(dot(reflect(-LIGHT, N), vec3(0, 0, 1)), 0.0), 22.0);
  vec3 col = mix(u_shadow, u_line, smoothstep(0.05, 0.95, diff)) + u_hi * (0.75 * spec);
  // Lines finer than the pixel: their average, not aliased sparkle.
  vec3 flat_ = mix(u_shadow, u_line, 0.62) + u_hi * 0.06;
  col = mix(col, flat_, smoothstep(0.3, 0.8, w));
  vec4 c = vec4(col * cov, cov);
  trailA = u_trail * smoothstep(0.1, 0.45, f.y);
  // The streak is liquid too: a soft sheen across it from the dye's own profile.
  vec3 tc = trailRamp(f.z) * (0.88 + 0.22 * smoothstep(0.45, 1.0, f.y));
  return mix(c, vec4(tc, 1.0), trailA);
}

void main() {
  vec2 s = v_uv * vec2(u_aspect, 1.0);
  vec3 f = field(s);
  vec2 gx = vec2(dFdx(f.x), dFdy(f.x));
  float ta;
  vec4 c = surface(f, gx, ta);
  vec4 outc = c + vec4(u_gap * u_gapA, u_gapA) * (1.0 - c.a);

  // The sphere: orthographic view of a chrome ball whose centre floats 0.35 R above the liquid.
  vec2 d = (s - u_ball.xy) / u_ball.z;
  float r = length(d);
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 N = vec3(d * step(r, 1.0), z);
  // The eye looks down at the liquid a little obliquely (from the top of the screen), so the
  // ball's lower half mirrors the stream and its upper half the sky, like a real chrome ball.
  const vec3 EYE = vec3(0.0, -0.5, -0.866);
  vec3 Rr = r < 1.0 ? reflect(EYE, N) : vec3(0.0, 0.0, -1.0);
  // Where the reflected ray meets the liquid (always computed, so the derivatives below are
  // defined for every pixel; outside the ball it's the pixel itself).
  float hgt = (0.35 + z) * u_ball.z;
  // (Distances squeezed by half: the mirrored lines stay broad instead of crowding into moiré.)
  float t = 0.5 * hgt / max(-Rr.z, 0.12);
  vec2 hit = s + Rr.xy * t;
  vec3 fr = field(hit);
  vec2 gr = vec2(dFdx(fr.x), dFdy(fr.x));
  float tr;
  vec4 cr = surface(fr, gr, tr);
  vec3 floorCol = cr.rgb + u_gap * (1.0 - cr.a);
  // Studio sky: a bright, soft gradient (pale lilac-white overhead, darker towards the horizon),
  // a big window up-left and a small bright key.
  float up = clamp(Rr.z, 0.0, 1.0);
  vec3 sky = mix(mix(u_shadow, u_line, 0.45), mix(u_line, vec3(1.0), 0.75), smoothstep(0.0, 0.8, up));
  sky += vec3(1.0) * smoothstep(0.8, 0.93, dot(Rr, normalize(vec3(-0.55, 0.62, 0.56)))) * 0.9;
  sky *= 1.0 - 0.45 * smoothstep(0.2, 1.0, dot(Rr, normalize(vec3(0.7, -0.5, 0.5))));
  vec3 env = mix(floorCol, sky, smoothstep(-0.06, 0.06, Rr.z));
  env *= 1.0 - 0.7 * exp(-Rr.z * Rr.z / 0.006); // the dark horizon line of a chrome ball
  float fres = 0.62 + 0.38 * pow(1.0 - z, 3.0);
  vec3 chrome = env * fres * vec3(0.93, 0.93, 0.98);
  chrome += vec3(1.0) * pow(max(dot(Rr, LIGHT), 0.0), 180.0) * 1.4;
  chrome *= 0.55 + 0.45 * smoothstep(-1.0, 0.4, N.y - 0.4 * N.x); // darker underside
  // Contact shadow on the liquid, falling down-right (away from the light).
  vec2 so = (s - u_ball.xy - vec2(0.12, -0.12) * u_ball.z) / u_ball.z;
  float sh = 1.0 - 0.65 * smoothstep(1.45, 0.85, length(so));
  outc.rgb *= sh;
  float disc = clamp((u_ball.z - r * u_ball.z) / u_px + 0.5, 0.0, 1.0);
  outc = mix(outc, vec4(chrome, 1.0), disc);

  outc.rgb = min(outc.rgb * u_glow, vec3(outc.a));
  o = outc;
}
