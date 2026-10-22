#version 300 es
// Tie-Dye: the dye pass, drawn at reduced resolution into an offscreen target (everything in it
// is soft); composite.frag then adds the cotton weave at full resolution.
//
// Dye is modelled as absorbance (Beer–Lambert): each palette color c becomes A = -log(c) in linear
// light, concentrations add absorbance, and the white cotton shows through as exp(-A). So where two
// dyes overlap they darken and mix like real dye, and thin dye reads as a faded tint.
//
// Band geometry (bandCoord) mirrors src/lib/tiedye.js — keep the constants in sync.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec2 u_res;
uniform int u_pattern;     // look a: 0 spiral, 1 bullseye, 2 crumple, 3 shibori
uniform int u_patternB;    // look b, which wicks outward from the knot as u_mix goes 0 → 1
uniform float u_mix;
uniform float u_arms;      // spiral arms of look a
uniform float u_armsB;     // … and of look b
uniform int u_fabric;      // 0 white cotton, 1 none (transparent where undyed)
uniform float u_twist;     // spiral twist, turns across the unit radius
uniform float u_turns;     // rotation, turns
uniform float u_flow;      // outward flow odometer, unit radii: bands are born at the knot
uniform float u_time;      // slow clock for the fabric's breathing
uniform int u_n;           // palette colors
uniform float u_edges[9];  // cumulative band edges, 0..1
uniform vec3 u_col[8];     // dye colors, sRGB
uniform vec4 u_rec[16];    // dye record, newest first: outer edge (unit radii), palette shift, ink
uniform float u_warp[64];  // waveform around the circle, -1..1
uniform float u_warpAmt;
uniform float u_bleed;     // 0..1+ edge softness
uniform float u_intensity; // global dye strength (flash-limited)
uniform vec4 u_bloom[12];  // x, y, radius, amount
uniform float u_bloomCol[12];
uniform float u_px;        // pixels per unit radius

const float TAU = 6.2831853;
const float RINGS = 1.8;
const float RING_DRIFT = 1.0;
const float FOLD = 1.6;
const float FOLD_TILT = 0.25;

// --- noise -------------------------------------------------------------------------------------
vec2 hash2(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 32768);
  q = q * uvec2(1597334673u, 3812015801u);
  q = (q.x ^ q.y) * uvec2(1597334673u, 3812015801u);
  return vec2(q) * (2.0 / 4294967295.0) - 1.0;
}
// Gradient noise, about -0.7..0.7.
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash2(i), f);
  float b = dot(hash2(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(hash2(i + vec2(0, 1)), f - vec2(0, 1));
  float d = dot(hash2(i + vec2(1, 1)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
// fbm, roughly 0..1 around 0.5.
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * gnoise(p);
    p = ROT * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return 0.5 + s;
}
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p);
    p = ROT * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return 0.5 + s;
}
// Ridged noise: 1 on thin, branching ridges, falling off to 0 away from them.
float ridged(vec2 p) {
  float s = 0.0, a = 0.6;
  for (int i = 0; i < 3; i++) {
    float n = 1.0 - abs(gnoise(p) * 1.6);
    s += a * n * n;
    p = ROT * p * 2.1 + 5.3;
    a *= 0.45;
  }
  return s / 0.93;
}

// --- helpers -----------------------------------------------------------------------------------
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 absorb(int i) { return -log(max(toLinear(u_col[i]), vec3(0.004))); }
// Palette color of band i under a record band's shift.
vec3 absorbShift(int i, float shift) { return absorb(int(mod(float(i) + shift, float(u_n)))); }

float warpAt(float turns) {
  float x = abs(fract(turns) * 2.0 - 1.0) * 63.0;
  int i = int(x);
  return mix(u_warp[i], u_warp[min(i + 1, 63)], x - float(i));
}

// One look of the cloth: band coordinate t and the pleat coordinate for crinkles.
void lookCoord(int pat, float arms, vec2 q, float r, float ang, float wob, out float t, out vec2 pleat) {
  if (pat == 0) {
    float tw = ang - u_turns + u_twist * (r - u_flow) + 0.05 * wob;
    t = fract(arms * tw);
    // Pleats of the twisted cloth run along the arms.
    // (Sampled on a circle so the noise has no seam where the angle wraps.)
    pleat = vec2(cos(TAU * tw), sin(TAU * tw)) * 2.6 + r * vec2(1.3, 0.9);
  } else if (pat == 1) {
    t = fract(RINGS * (r - u_flow) - RING_DRIFT * u_turns + 0.06 * wob);
    pleat = vec2(cos(TAU * ang), sin(TAU * ang)) * 6.0 + (r - u_flow) * vec2(1.4, 1.1);
  } else if (pat == 2) {
    float c = fbm4(q * 1.3) * 2.4 + 0.35 * fbm3(q * 4.0) + 0.8 * r;
    t = fract(c - 0.8 * u_flow + 0.5 * u_turns + 0.05 * wob);
    pleat = q * 2.2;
  } else {
    float th = TAU * FOLD_TILT * u_turns;
    vec2 d = vec2(cos(th), sin(th));
    float u = abs(dot(q, d)) - u_flow + 0.03 * wob;
    t = abs(fract(u / FOLD + 0.5) * 2.0 - 1.0);
    pleat = vec2(u, dot(q, vec2(-d.y, d.x)));
  }
}

// Dye absorbance for one look: bands from the palette, shifted by the record band the pixel is in
// (and its neighbour across a dye front), plus crinkles.
void dyeLook(int pat, float arms, vec2 q, float r, float ang, float wob, vec2 drape, vec2 wq, float edgeN,
             float fineN, float bleed, float recShift, float nbShift, float front, out vec3 A,
             out float cover, out float crinkle) {
  float t;
  vec2 pleat;
  lookCoord(pat, arms, q, r, ang, wob, t, pleat);
  // Ragged edges: large wandering plus fine fibre bleed.
  t += bleed * (0.14 * (edgeN - 0.5) + 0.025 * fineN);
  if (pat != 3) t = fract(t);
  else t = clamp(t, 0.0, 1.0);

  // Band and nearest edge.
  int i = 0;
  for (int k = 0; k < 7; k++) {
    if (k < u_n - 1 && t >= u_edges[k + 1]) i = k + 1;
  }
  float dl = t - u_edges[i];
  float du = u_edges[i + 1] - t;
  int nb;
  float d;
  if (dl < du) {
    nb = i == 0 ? u_n - 1 : i - 1;
    d = dl;
    if (pat == 3 && i == 0) nb = 0;
  } else {
    nb = i == u_n - 1 ? 0 : i + 1;
    d = du;
    if (pat == 3 && i == u_n - 1) nb = i;
  }
  // Two dyes meet: their concentrations roll off over `soft`; noise decides whether they overlap
  // (darker mixed border) or leave a thin undyed gap.
  float soft = 0.008 + bleed * (0.03 + 0.05 * edgeN);
  float gap = (fbm3(wq * 0.7 + 40.0) - 0.55) * soft * 3.0;
  float cSelf = smoothstep(-soft, soft, d + gap);
  float cNb = smoothstep(-soft, soft, -d + gap);
  // Across a dye front the palette shift changes: blend the two (front: 1 = this record band).
  A = front * (cSelf * absorbShift(i, recShift) + cNb * absorbShift(nb, recShift))
    + (1.0 - front) * (cSelf * absorbShift(i, nbShift) + cNb * absorbShift(nb, nbShift));
  cover = max(cSelf, cNb) + 0.5 * min(cSelf, cNb);

  // Crinkles: white resist lines where the folded cloth kept the dye out.
  float cr = ridged(pleat + 0.4 * drape);
  float cr2 = ridged(q * 5.0 + 9.0);
  // Crinkles come in clusters where the cloth bunched, not evenly everywhere.
  float bunch = smoothstep(0.38, 0.72, fbm3(q * 2.3 + 50.0));
  crinkle = (smoothstep(0.7, 0.96, cr) * 0.95 + smoothstep(0.9, 0.99, cr2) * 0.35) * bunch;
  if (pat == 3) {
    // Folded-and-clamped cloth: straight resist lines along the folds and across them.
    float fx = abs(fract(pleat.x / FOLD + 0.5) - 0.5) * FOLD;
    float fy = abs(fract(pleat.y / (FOLD * 0.5)) - 0.5) * FOLD * 0.5;
    float wline = 0.02 + 0.05 * edgeN * bleed + 0.02 * fineN;
    crinkle = max(crinkle, max((1.0 - smoothstep(0.0, wline, fx)) * 0.85, (1.0 - smoothstep(0.0, wline * 0.8, fy)) * 0.7));
  }
  if (pat == 2) crinkle = max(crinkle, smoothstep(0.62, 0.9, cr) * (0.5 + 0.5 * bunch));
  crinkle = clamp(crinkle * (0.6 + 0.6 * fineN + 0.4 * edgeN), 0.0, 1.0);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_px;

  // The shirt lies a little unevenly: a slow, large-scale drape warp, breathing very gently.
  vec2 drape = vec2(fbm3(p * 0.9 + 3.1 + u_time * 0.01), fbm3(p * 0.9 - 7.7 - u_time * 0.01)) - 0.5;
  vec2 q = p + 0.09 * drape;
  // The bound center of a twist is a crumpled knot: extra local warp there.
  q += 0.05 * (1.0 - smoothstep(0.0, 0.3, length(p))) * (vec2(fbm3(p * 9.0 + 2.0), fbm3(p * 9.0 - 4.0)) - 0.5);

  float r = length(q);
  float ang = atan(q.y, q.x) / TAU;
  float bleed = u_bleed;

  // Domain-warped noise for bleeding, irregular edges.
  vec2 wq = q * 3.0 + 1.7 * (vec2(fbm3(q * 2.2 + 11.0), fbm3(q * 2.2 - 5.0)) - 0.5);
  float edgeN = fbm4(wq);
  float fineN = gnoise(q * 22.0 + edgeN * 3.0);
  float wob = u_warpAmt * warpAt(ang) * smoothstep(0.03, 0.4, r);

  // The dye record: which band (laid down on some earlier beat) this point is in, and how far it
  // is from the front with its neighbour. Fronts wick raggedly.
  float age = r + (0.06 + 0.1 * bleed) * (edgeN - 0.5) + 0.02 * fineN;
  int rk = 15;
  for (int k = 14; k >= 0; k--) {
    if (age < u_rec[k].x) rk = k;
  }
  float inner = rk == 0 ? -1e3 : u_rec[rk - 1].x;
  float outer = u_rec[rk].x;
  bool toInner = age - inner < outer - age;
  float df = toInner ? age - inner : outer - age;
  vec4 nbRec = toInner ? u_rec[max(rk - 1, 0)] : u_rec[min(rk + 1, 15)];
  float fsoft = 0.012 + 0.03 * bleed;
  float front = smoothstep(-fsoft, fsoft, df);
  float ink = mix(nbRec.z, u_rec[rk].z, front);
  // A tide line where two dyes met: a thin, darker rim.
  float tide = exp(-pow(df / (fsoft * 1.2), 2.0)) * 0.35;

  vec3 A;
  float cover;
  float crinkle;
  dyeLook(u_pattern, u_arms, q, r, ang, wob, drape, wq, edgeN, fineN, bleed, u_rec[rk].y, nbRec.y, front, A, cover, crinkle);
  if (u_mix > 0.0) {
    // The next look wicks outward from the knot along a ragged front.
    float R = u_mix * 2.9 - 0.45;
    float m = 1.0 - smoothstep(R - 0.15, R + 0.15, r + 0.5 * (fbm3(wq * 0.5 + 70.0) - 0.5));
    if (m > 0.0) {
      vec3 A2;
      float cover2;
      float crinkle2;
      dyeLook(u_patternB, u_armsB, q, r, ang, wob, drape, wq, edgeN, fineN, bleed, u_rec[rk].y, nbRec.y, front, A2, cover2, crinkle2);
      A = mix(A, A2, m);
      cover = mix(cover, cover2, m);
      crinkle = mix(crinkle, crinkle2, m);
    }
  }
  A *= 1.0 + tide;

  // Uneven dyeing: pooled darker in places, faded in others.
  float pool = fbm4(q * 1.6 + 23.0);
  float dens = mix(0.45, 1.35, smoothstep(0.2, 0.8, pool)) * (0.9 + 0.2 * edgeN) * ink;
  // The tight center of a twist takes less dye.
  dens *= mix(0.55, 1.0, smoothstep(0.0, 0.25, r));
  dens *= 1.0 - 0.9 * crinkle;

  // Fresh dye blooms bleeding outward.
  for (int k = 0; k < 12; k++) {
    vec4 b = u_bloom[k];
    if (b.w <= 0.0) continue;
    float dn = length(q - b.xy) / max(b.z, 1e-3);
    dn *= 1.0 + 0.7 * (edgeN - 0.5) + 0.25 * fineN;
    float c = (1.0 - smoothstep(0.45, 1.0, dn)) + 0.3 * exp(-pow((dn - 0.88) / 0.1, 2.0));
    int bi = min(int(u_bloomCol[k] * float(u_n)), u_n - 1);
    float amt = clamp(c * b.w * (1.0 - 0.7 * crinkle), 0.0, 1.0);
    // Fresh dye mostly displaces what was there (it floods the fibres), darkening only a little.
    A = mix(A, absorb(bi) / max(dens, 0.5), amt * 0.95) + amt * 0.12 * absorb(bi);
    cover = max(cover, amt);
  }

  A *= dens * u_intensity;
  vec3 dyed = exp(-A);

  // Linear, premultiplied output; composite.frag adds the pixel-scale weave and encodes sRGB.
  float light = 1.0 - 0.07 * (drape.x + drape.y);
  vec3 cotton = vec3(0.93, 0.92, 0.89);
  if (u_fabric == 0) {
    o = vec4(cotton * dyed * light, 1.0);
  } else {
    // No fabric: dye floats on its own. Color at its own strength; alpha from how much dye is here.
    float amount = clamp(cover * dens * u_intensity, 0.0, 1.0);
    float alpha = smoothstep(0.02, 0.75, amount);
    o = vec4(exp(-A / max(amount, 0.35)) * light * alpha, alpha);
  }
}
