#version 300 es
// Eclipse: the full-screen pass, in polar coordinates around the composition centre.
// Units: the composition's unit circle (lib/eclipse.js fitEclipse) — u_radius px per unit.
precision highp float;

uniform sampler2D u_lev;   // 256 × 2: row 0 corona level per angle, row 1 ring ripple (−1..1)
uniform vec2 u_center;     // px
uniform float u_radius;    // px per unit
uniform float u_disc;      // black disc radius
uniform float u_outer;     // annulus outer radius
uniform float u_swell;     // bass swell (flash-limited), 0–1
uniform float u_rot;       // pattern rotation, rad
uniform float u_time;      // drift clock, s
uniform float u_reach;     // tendril reach at level 1, units
uniform float u_clouds;    // cloud amount 0–1
uniform float u_mid;       // smoothed mids 0–1
uniform vec2 u_flares[4];  // (distance past the ring, amplitude)
uniform vec3 u_gamma;      // tint: colour = grey^gamma
uniform float u_sky;       // 1 = opaque black sky, 0 = black is transparent
uniform sampler2D u_fields; // cloud fields (clouds.frag), screen-aligned
uniform vec2 u_res;        // canvas px

out vec4 outColor;

const float TAU = 6.28318531;

// #include noise

// ---- Dendrites: procedural Lichtenberg trees in (u, ρ) — u = angle in trunk cells, ρ = distance
// past the ring. Each of N0 cells around the ring roots one trunk at the ring; it forks into two
// branches (one each side) and each branch into a twig. Every limb is a straight, tapering segment
// in a domain-warped space, so the warp bends them into wandering filaments while forks stay
// sharp. Limbs are continuous lines that taper to nothing: no specks.
const float N0 = 96.0; // trunks around the ring (integer: the pattern wraps)

vec4 hash4(vec2 p) {
  vec4 p4 = fract(p.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// A tapering limb that starts at (x0, r0) in (u, ρ), leans `s` u per unit ρ, is `l` long and `w0`
// wide (units) at its root. `ku` = units per u at this radius, `px` = units per pixel.
// Returns (anti-aliased coverage of the limb, a soft grey sheath around it — the frond's body).
vec2 limb(vec2 q, float x0, float r0, float s, float l, float w0, float ku, float px) {
  float t = (q.y - r0) / l;
  if (t < 0.0 || t > 1.0) return vec2(0.0);
  float sk = s * ku;
  float d = abs(q.x - x0 - s * (q.y - r0)) * ku * inversesqrt(1.0 + sk * sk);
  float w = w0 * pow(1.0 - t, 0.75);
  float core = clamp((w - d) / px + 0.5, 0.0, 1.0) * clamp(2.0 * w / px, 0.0, 1.0);
  float sw = 4.0 * w0 + 2.0 * px;
  float sheath = exp(-d * d / (sw * sw)) * (1.0 - t) * min(1.0, t * 8.0 + 0.3);
  return vec2(core, sheath);
}

// One tree rooted in cell `c` of `n` around the ring, reach `L`, root width `W`: a trunk with
// `forks` branches alternating sides (longer near the root, like a frond), each with two twigs.
// Trees clump: a slow noise around the ring makes neighbours grow long together, into fronds.
vec2 tree(vec2 q, float c, float n, float L, float W, float ku, float px, int forks, float time) {
  float cm = mod(c, n);
  vec4 h = hash4(vec2(cm, n));
  float clump = 0.4 + 0.8 * smoothstep(-0.3, 0.35, gnoise(vec2(cm / 6.0, 0.5 + time * 0.02), n / 6.0));
  float x0 = c + 0.5 + 0.5 * (h.x - 0.5);
  float l0 = L * (0.3 + 0.7 * h.y) * clump;
  float s0 = (h.w - 0.5) * 1.5;
  float w0 = W * (0.6 + 0.8 * h.z) * (0.7 + 0.3 * clump);
  vec2 v = limb(q, x0, 0.0, s0, l0, w0, ku, px);
  float side = h.x > 0.5 ? 1.0 : -1.0;
  for (int b = 0; b < forks; b++) {
    vec4 g = hash4(vec2(cm + 0.37 * float(b + 1), n + 1.0));
    float dir = side * (b % 2 == 0 ? 1.0 : -1.0);
    float f = (float(b) + 0.3 + 0.5 * g.x) / float(forks) * 0.75; // fork point along the trunk
    float rb = f * l0;
    float xb = x0 + s0 * rb;
    float sb = s0 + dir * (2.5 + 5.0 * g.y);
    float lb = (1.0 - f) * l0 * (0.4 + 0.5 * g.z);
    float wb = w0 * pow(1.0 - f, 0.75) * 0.75;
    v = max(v, vec2(0.88, 0.8) * limb(q, xb, rb, sb, lb, wb, ku, px));
    for (int k = 0; k < 2; k++) {
      float e = 0.2 + 0.3 * float(k) + 0.2 * fract(g.w * float(7 + 5 * k)); // twig fork along the branch
      float td = k == 0 ? -dir : dir;
      float rt = rb + e * lb;
      float xt = xb + sb * e * lb;
      float st = sb + td * (4.0 + 4.0 * g.x);
      v = max(v, vec2(0.75, 0.6) * limb(q, xt, rt, st, (1.0 - e) * lb * 0.7, wb * pow(1.0 - e, 0.75) * 0.8, ku, px));
    }
  }
  return v;
}

void main() {
  vec2 p = (gl_FragCoord.xy - u_center) / u_radius;
  float r = length(p);
  float px = 1.0 / u_radius; // one pixel in units
  float ang = atan(p.x, -p.y); // 0 = bottom, +π/2 = right
  float su = ang / TAU + 0.5;
  float lvl = texture(u_lev, vec2(su, 0.25)).r;
  float rip = texture(u_lev, vec2(su, 0.75)).r;

  float inner = u_disc + 0.0035 * rip;
  float outer = u_outer + 0.007 * rip;
  float ringM = clamp((r - inner) / px + 0.5, 0.0, 1.0) * clamp((outer - r) / px + 0.5, 0.0, 1.0);

  float v = 0.0;
  if (r > outer - 0.02) {
    float rho = max(r - outer, 0.0);

    // Flares: rings of extra light travelling outward.
    float flare = 0.0;
    for (int i = 0; i < 4; i++) {
      float d = (rho - u_flares[i].x) / 0.06;
      flare += u_flares[i].y * exp(-d * d);
    }

    // ---- Corona: radially stretched, domain-warped ridged noise, gated by the level per angle.
    float L = 0.055 + u_reach * lvl + 0.22 * flare * (0.4 + lvl);
    float t = rho / L;
    float corona = 0.0;
    if (t < 1.05) {
      float u = (ang + u_rot) / TAU * N0;
      // Domain warp: a slow wander plus a finer jitter (lightning kinks), stronger toward the tips.
      vec2 wq = vec2(u * 0.25, rho * 5.0 - u_time * 0.05);
      vec2 warp = vec2(gnoise(wq, N0 * 0.25), gnoise(wq + vec2(7.3, 2.9), N0 * 0.25));
      float jit = gnoise(vec2(u, rho * 28.0 + u_time * 0.1), N0);
      vec2 q = vec2(u + (0.9 + 0.8 * t) * warp.x + 0.25 * t * jit, rho);
      float ku = TAU * r / N0; // units per cell at this radius
      float W = 0.0045 + 0.003 * lvl;
      float c0 = floor(q.x);
      vec2 fil = vec2(0.0);
      for (int j = -1; j <= 1; j++) fil = max(fil, tree(q, c0 + float(j), N0, L, W, ku, px, 4, u_time));
      // A finer fringe of short, forked hairs between the trees.
      vec2 q1 = vec2(q.x * 3.0, q.y);
      float c1 = floor(q1.x);
      for (int j = -1; j <= 1; j++) {
        fil = max(fil, vec2(0.85, 0.5) * tree(q1, c1 + float(j), 3.0 * N0, 0.02 + 0.3 * L, 0.6 * W, ku / 3.0, px, 1, u_time));
      }
      corona = max(fil.x, 0.3 * fil.y) * mix(1.0, 0.62, smoothstep(0.0, 1.0, t));
      // The white mass fused to the ring, with a torn edge.
      float fused = 1.0 - smoothstep(0.0, 0.003 + 0.004 * lvl, rho - 0.008 - 0.02 * lvl - 0.01 * warp.x - 0.005 * jit);
      corona = max(corona, fused);
      corona *= 1.0 + 0.8 * flare;
    }

    // ---- Marbled ink clouds, from the low-resolution fields (clouds.frag); crisp edges and
    // streaks are cut here at full resolution.
    float cloud = 0.0;
    if (u_clouds > 0.0) {
      vec4 fld = texture(u_fields, gl_FragCoord.xy / u_res);
      float dens = fld.r * 2.0 - 1.0;
      float m = (fld.g - 0.5) * 40.0;
      float vn = fld.b * 2.0 - 1.0;
      float tone = mix(0.5, 1.0, smoothstep(-0.15, 0.25, fld.a * 2.0 - 1.0));
      float th = 0.16 - 0.28 * u_clouds - 0.06 * u_mid;
      float aa = 2.2 * px; // density units per pixel ≈ px (its gradient is ~1–2 per unit)
      // Marbling: fine grey-white streaks following the warp (marbled paper), dark cracks.
      float streak = abs(fract(m) - 0.5) * 2.0; // 0 on a streak … 1 between
      float mw = 14.0 * 2.0 * px * 2.0; // streak phase per pixel
      float lines = smoothstep(0.35 - mw, 0.35 + mw, streak);
      // Crisp body; past its edge the marbling streaks run on as fibres that thin out: feathery.
      float fibres = (1.0 - smoothstep(0.12, 0.12 + mw, streak)) * smoothstep(th - 0.07, th, dens);
      float body = max(smoothstep(th - aa, th + aa, dens), 0.8 * fibres);
      float vein = smoothstep(0.0, 0.04 + aa, abs(vn));
      // Brighter toward the eroded edge, like ink pooled at a drying front.
      float rim = smoothstep(th + 0.12, th, dens);
      cloud = body * tone * mix(0.9, 1.0, lines) * mix(0.1, 1.0, vein) * (0.85 + 0.15 * rim);
      cloud *= min(1.0, 0.5 + u_clouds) * (1.0 + 0.35 * flare);
    }

    float glow = exp(-rho / (0.004 + 0.012 * u_swell)) * (0.45 + 0.4 * u_swell);
    float haze = 0.14 * flare * (1.0 - smoothstep(0.0, 0.6, rho));
    v = max(max(corona, cloud), glow + haze);
    v *= step(outer - 0.02, r);
  }
  v = mix(v, 1.0, ringM);
  v *= clamp((r - inner) / px + 0.5, 0.0, 1.0); // the disc is pure black
  v = clamp(v, 0.0, 1.0);

  vec3 col = pow(vec3(v), u_gamma);
  float a = mix(max(col.r, max(col.g, col.b)), 1.0, u_sky);
  outColor = vec4(col, a);
}
