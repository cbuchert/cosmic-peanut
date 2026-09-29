#version 300 es
// Dark Sun: after Mogwai's *Every Country's Sun*. One full-screen pass.
//
// Sky (ash grey over salmon) and ground (dark mauve) are watercolour washes: smooth,
// domain-warped value-noise fbm at low frequencies, drifting very slowly. No grain, no dots.
// The dark sun has a thin rim with a travelling "diamond ring" and soft corona streaks. Below
// the glowing horizon hangs the upside-down range: the live spectrum profile (u_prof, one texel
// per column, straight segments between them, mirrored with the bass at the centre), and a beam
// of light falls from its heart to the bottom edge.
//
// Output is premultiplied. Painted backdrop: opaque. Backdrop "none": sky and ground are
// transparent; the disc and the range are opaque shapes and the lights carry alpha = their
// brightest channel, so they float over the desktop without haze.
precision highp float;

out vec4 o;

uniform sampler2D u_prof;  // N x 1 R32F: depth per column, 0-1
uniform sampler2D u_bg;    // painted sky and ground washes (backdrop.frag), quarter resolution
uniform float u_n;         // N
uniform vec2 u_res;        // drawing-buffer pixels
uniform float u_unit;      // min(w, h)
uniform float u_horizon;   // px from the top
uniform vec3 u_sun;        // x, y (px from the top), radius
uniform float u_rangeHalf; // px
uniform float u_rangeDepth;// px for a full-level peak
uniform float u_beamW;     // beam core half-width, px
uniform float u_beamB;     // beam brightness (param x pulse x surge)
uniform float u_rim;       // rim glow
uniform float u_reach;     // corona reach, sun radii
uniform float u_diamond;   // diamond-ring angle, rad (ccw from +x, y up)
uniform float u_corona;    // corona rotation, rad
uniform float u_glow;      // horizon glow level (mids + surge)
uniform float u_painted;   // 1 = paint sky and ground, 0 = transparent
uniform vec3 u_c[8];       // palette: sky top, sky low, ground, wash, glow, rim, disc, corona

const float TAU = 6.2831853;

// #include noise

float depthAt(float x) {
  // Straight segments between texel centres, like a ridgeline.
  float s = clamp(x, 0.0, 1.0) * u_n - 0.5;
  float i0 = floor(s);
  float f = s - i0;
  float a = texelFetch(u_prof, ivec2(int(clamp(i0, 0.0, u_n - 1.0)), 0), 0).r;
  float b = texelFetch(u_prof, ivec2(int(clamp(i0 + 1.0, 0.0, u_n - 1.0)), 0), 0).r;
  return mix(a, b, f);
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y); // px, y down
  vec2 p = fc / u_unit;                                     // unit-scaled, for textures
  float px = 1.0 / u_unit;
  float cx = 0.5 * u_res.x;
  float hz = u_horizon;

  vec3 SKY_TOP = u_c[0], SKY_LOW = u_c[1], GROUND = u_c[2], WASH = u_c[3];
  vec3 GLOW = u_c[4], RIM = u_c[5], DISC = u_c[6], CORONA = u_c[7];

  // ---- sun geometry
  vec2 ds = (fc - u_sun.xy) / u_sun.z;   // sun radii, y down
  float d = length(ds);
  float ang = atan(-ds.y, ds.x);          // y up
  float aa = 1.5 / u_sun.z;               // ~1.5 px in sun radii

  // ---- backdrop: the washes come from backdrop.frag (quarter resolution); the sun's smoky halo
  // and its long, thin dark filaments (like the cover's) are drawn here at full resolution.
  vec3 bg = vec3(0.0);
  float streakDark = 0.0;
  if (u_painted > 0.5) {
    bg = texture(u_bg, gl_FragCoord.xy / u_res).rgb;
    if (fc.y < hz && d > 1.0) {
      float r = d - 1.0;
      float fil = pow(noise(circ(ang + u_corona * 0.3, 1.4) + 0.5), 40.0);
      fil += 0.5 * pow(noise(circ(ang - u_corona, 7.0) + vec2(4.0 + r * 0.1)), 14.0);
      streakDark = min(0.6, fil * exp(-r / (2.2 * u_reach)));
      float halo = exp(-r / (0.55 * u_reach));
      bg = mix(bg, bg * mix(vec3(0.55), CORONA * 0.9, 0.35), 0.55 * halo);
    }
  }

  vec3 light = vec3(0.0);

  // ---- the dark sun
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  // Interior: a dark smoky disc, faintly lit on the diamond's side.
  vec2 dir = vec2(cos(u_diamond), -sin(u_diamond));
  float lit = max(0.0, dot(ds, dir));
  float smoke = d < 1.1 ? fbm3(ds * 2.2 + 3.0) : 0.5;
  vec3 discCol = DISC * (0.75 + 0.6 * smoke);
  // A smoky crescent of light just inside the rim on the diamond's side.
  discCol += RIM * u_rim * (0.1 + 0.3 * smoke) * pow(lit, 4.0) * smoothstep(0.55, 1.0, d);
  // Rim: thin bright ring, brightest at the diamond.
  float da = atan(sin(ang - u_diamond), cos(ang - u_diamond));
  float diamond = exp(-da * da / 0.3);
  float ring = exp(-pow((d - 1.0) / 0.03, 2.0));
  float outer = d > 1.0 ? exp(-(d - 1.0) / 0.12) : 0.0;
  float rimI = u_rim * (0.3 + 2.4 * diamond);
  light += RIM * rimI * (ring * 0.9 + outer * 0.5);
  // The diamond's bloom spills into the sky.
  light += RIM * u_rim * diamond * diamond * exp(-max(d - 1.0, 0.0) / 0.22) * 0.8 * step(1.0, d);
  // Corona: soft thin streaks, slowly turning, reaching further with the bass.
  float r = d - 1.0;
  if (d > 0.98 && r < 2.6 * u_reach) {
    float s1 = noise(circ(ang + u_corona, 6.5) + vec2(r * 0.6));
    float s2 = noise(circ(ang - 0.7 * u_corona, 2.8) + vec2(5.0, r * 0.4));
    float streak = pow(s1, 4.0) * 0.8 + pow(s2, 5.0) * 0.6;
    float fall = exp(-r / (0.45 * u_reach));
    float halo = exp(-r / (0.2 * u_reach));
    light += CORONA * (streak * fall * 0.45 + halo * 0.2) * u_rim * (0.5 + 0.8 * diamond);
  }

  // ---- horizon: a thin line of light, breathing glow above and a little below
  float dy = fc.y - hz;
  float line = exp(-pow(dy / (0.0022 * u_unit), 2.0));
  float above = dy < 0.0 ? exp(dy / (0.035 * u_unit)) : exp(-dy / (0.006 * u_unit));
  light += GLOW * (line * (0.7 + 0.4 * u_glow) + above * 0.45 * u_glow);

  // ---- the upside-down range: the live spectrum
  float rangeCov = 0.0;
  vec3 rangeCol = vec3(0.0);
  float ux = (fc.x - cx) / u_rangeHalf;          // -1..1 across the range
  if (abs(ux) < 1.0 && dy > -2.0) {
    float x01 = ux * 0.5 + 0.5;
    float step1 = 0.25 / (2.0 * u_rangeHalf); // a quarter pixel in x01
    // Coverage from four sub-pixel columns (exact for steep flanks, no smear below the tips).
    float cov = 0.0;
    float dpth = 0.0;
    for (int k = 0; k < 4; k++) {
      float dk = depthAt(x01 + (float(k) - 1.5) * step1) * u_rangeDepth;
      cov += clamp(dk - dy + 0.5, 0.0, 1.0);
      dpth += dk;
    }
    dpth *= 0.25;
    rangeCov = 0.25 * cov * step(-1.0, dy);
    float k = clamp(dy / max(u_rangeDepth, 1.0), 0.0, 1.0);
    float mott = fbm3(p * vec2(10.0, 2.5) + 11.0);
    float edge = smoothstep(0.0, 0.45 * max(dpth, 1.0), dpth - dy); // darker, pinker toward the tips
    rangeCol = mix(mix(GLOW, SKY_LOW, 0.6) * 0.8, GLOW, mix(0.35, 1.0, edge));
    rangeCol = mix(rangeCol, rangeCol * mix(vec3(1.0), SKY_LOW, 0.3), smoothstep(0.2, 1.0, k));
    rangeCol *= (0.84 + 0.26 * mott) * (0.8 + 0.25 * u_glow);
    // Light spilling from the ridges onto the ground.
    float spill = dy > 0.0 && dy > dpth ? exp((dpth - dy) / (0.012 * u_unit)) : 0.0;
    light += GLOW * spill * 0.16 * u_glow;
  }

  // ---- the beam
  float bx = abs(fc.x - cx);
  if (dy > 0.0) {
    float core = exp(-pow(bx / u_beamW, 2.0));
    float halo = exp(-bx / (u_beamW * 5.0));
    vec3 bc = mix(GLOW, mix(GLOW, SKY_LOW, 0.4), smoothstep(0.3, 1.0, dy / (u_res.y - hz)));
    light += bc * u_beamB * (core * 1.2 + halo * 0.3);
  } else {
    // A faint column of light rising toward the sun, as in the cover.
    float col = exp(-pow(bx / (u_beamW * 6.0), 2.0)) * exp(dy / (0.25 * u_unit));
    light += mix(SKY_LOW, GLOW, 0.5) * col * 0.12 * u_beamB;
  }

  // ---- composite (premultiplied)
  vec4 c;
  if (u_painted > 0.5) {
    vec3 col = bg * (1.0 - streakDark);
    col = mix(col, rangeCol, rangeCov);
    col = mix(col, discCol, disc);
    col += light * (1.0 - 0.85 * disc);
    c = vec4(min(col, vec3(1.0)), 1.0);
  } else {
    // Cut the faintest light so nothing hazes the desktop.
    light = max(light - 0.015, 0.0);
    vec4 acc = vec4(rangeCol * rangeCov, rangeCov);
    acc = vec4(discCol, 1.0) * disc + acc * (1.0 - disc);
    acc.rgb += light * (1.0 - 0.85 * disc);
    acc.rgb = min(acc.rgb, vec3(1.0));
    acc.a = clamp(max(acc.a, max(acc.r, max(acc.g, acc.b))), 0.0, 1.0);
    c = acc;
  }
  o = c;
}
