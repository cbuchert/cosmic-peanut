#version 300 es
// MacCormack correction with a min/max limiter (sharp, stable line contours far downstream), then
// the step's sources and boundaries: inflow change, vorticity confinement, beat kicks, trail dye
// injection and ageing, the inflow edge, and the sphere (fluid inside moves with it).
precision highp float;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
uniform sampler2D u_v0;   // state
uniform sampler2D u_s0;
uniform sampler2D u_vf;   // forward
uniform sampler2D u_sf;
uniform sampler2D u_vb;   // backward
uniform sampler2D u_sb;
uniform sampler2D u_curl;
uniform float u_dt;
uniform float u_dU;       // inflow speed change this step (a uniform, divergence-free shift)
uniform float u_vort;     // vorticity confinement strength (0 = off)
uniform float u_kick;     // signed cross-stream kick speed delivered this step
uniform float u_trail;    // 1 = inject dye
uniform float u_dyeLife;  // s
// #include common

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(u_v0, 0);
  vec2 uv = (vec2(q) + 0.5) * u_texel;
  vec2 P = uv * u_L;
  vec4 V0 = texelFetch(u_v0, q, 0);
  vec4 S0 = texelFetch(u_s0, q, 0);
  vec4 vf = texelFetch(u_vf, q, 0);
  vec4 sf = texelFetch(u_sf, q, 0);
  vec4 vn = vf + 0.5 * (V0 - texelFetch(u_vb, q, 0));
  vec4 sn = sf + 0.5 * (S0 - texelFetch(u_sb, q, 0));

  // Limiter: clamp to the range of the four texels the forward backtrace interpolated.
  vec2 back = uv - u_dt * V0.xy / u_L;
  vec2 g = back / u_texel - 0.5;
  ivec2 b0 = clamp(ivec2(floor(g)), ivec2(0), sz - 1);
  ivec2 b1 = min(b0 + 1, sz - 1);
  vec4 va = texelFetch(u_v0, b0, 0), vb = texelFetch(u_v0, ivec2(b1.x, b0.y), 0);
  vec4 vc = texelFetch(u_v0, ivec2(b0.x, b1.y), 0), vd = texelFetch(u_v0, b1, 0);
  vn = clamp(vn, min(min(va, vb), min(vc, vd)), max(max(va, vb), max(vc, vd)));
  // ψ is relative to each texel's own y: compare line coordinates, not displacements.
  float y = P.y;
  float y0 = posOf(b0).y - y;
  float y1 = posOf(b1).y - y;
  vec4 sa = texelFetch(u_s0, b0, 0) + vec4(y0, 0, 0, 0), sb = texelFetch(u_s0, ivec2(b1.x, b0.y), 0) + vec4(y0, 0, 0, 0);
  vec4 sc = texelFetch(u_s0, ivec2(b0.x, b1.y), 0) + vec4(y1, 0, 0, 0), sd = texelFetch(u_s0, b1, 0) + vec4(y1, 0, 0, 0);
  vec4 smin = min(min(sa, sb), min(sc, sd));
  vec4 smax = max(max(sa, sb), max(sc, sd));
  sn = clamp(sn, smin, smax);
  // The line coordinate takes half the correction: the full one saw-tooths strongly sheared,
  // squeezed lines at the grid scale; half keeps the curls crisp without the teeth.
  sn.r = mix(sf.r, sn.r, 0.5);
  if (back.x < 0.5 * u_texel.x || q.x == 0) { vn = vf; sn = sf; }

  vn.x += u_dU;

  // Vorticity confinement: spin small eddies back up that the grid would smear out.
  if (u_vort > 0.0) {
    ivec2 m = sz - 1;
    float wl = abs(texelFetch(u_curl, clamp(q - ivec2(1, 0), ivec2(0), m), 0).r);
    float wr = abs(texelFetch(u_curl, clamp(q + ivec2(1, 0), ivec2(0), m), 0).r);
    float wb = abs(texelFetch(u_curl, clamp(q - ivec2(0, 1), ivec2(0), m), 0).r);
    float wt = abs(texelFetch(u_curl, clamp(q + ivec2(0, 1), ivec2(0), m), 0).r);
    float w = texelFetch(u_curl, q, 0).r;
    vec2 gr = vec2(wr - wl, wt - wb);
    vec2 n = gr / (length(gr) + 1e-5);
    // Only in the wake (a cone widening downstream of the sphere) and only on real eddies, so the
    // stream beside and ahead of the sphere stays laminar and grid noise isn't pumped up.
    float R0 = u_ball.z;
    float ahead = P.x - u_ball.x;
    float halfw = 1.6 * R0 + 0.3 * max(ahead, 0.0);
    float cone = smoothstep(-R0, 0.5 * R0, ahead) * (1.0 - smoothstep(halfw, halfw + 2.0 * R0, abs(P.y - u_ball.y)));
    float eddy = smoothstep(0.5, 2.0, abs(w) * R0 / max(u_U, 0.02));
    vn.xy += u_dt * u_vort * u_texel.y * u_L.y * vec2(n.y, -n.x) * w * cone * eddy;
  }

  // Beat kick: a cross-stream shove just behind the sphere; the projection rolls it into a
  // vortex pair that knocks the wake to one side.
  float R = u_ball.z;
  vec2 kb = P - (u_ball.xy + vec2(1.5 * R, 0.0));
  vn.y += u_kick * exp(-dot(kb, kb) / (0.36 * R * R));

  // Trail: dye marks the sphere's line of approach and is laid at its upstream contact point,
  // then flows on with the liquid; it ages (dye × seconds) only once past the sphere, so it runs
  // red → orange downstream.
  float dye = sn.g;
  float agem = sn.b;
  float life = exp(-u_dt / u_dyeLife);
  dye *= life;
  agem *= life;
  if (u_trail > 0.0) {
    // Ahead of the sphere the streak is its line of approach: held straight along the sphere's
    // current cross-stream position (cleared elsewhere), so it always runs into the sphere.
    float band = (P.y - u_ball.y) / (0.1 * R);
    if (P.x < u_ball.x - 1.1 * R) {
      dye = exp(-band * band);
      agem = 0.0;
    }
    // Where it meets the sphere it wraps the front of it — a thin film over the upstream half,
    // which the flow peels off both flanks into the wake.
    vec2 rel = P - u_ball.xy;
    float rr = length(rel);
    float film = exp(-pow((rr - 1.04 * R) / (0.045 * R), 2.0)) * smoothstep(-0.2, -0.6, rel.x / max(rr, 1e-5));
    dye = max(dye, film);
  }
  if (P.x > u_ball.x) agem += dye * u_dt;
  sn.g = min(dye, 1.0);
  sn.b = min(agem, 60.0);

  if (q.x == 0) { vn = vec4(u_U, 0.0, 0.0, 0.0); sn.r = 0.0; }
  if (solid(P)) vn.xy = solidVel(P);
  vn.xy = clamp(vn.xy, -3.0, 3.0);
  oV = vec4(vn.xy, 0.0, 1.0);
  oS = vec4(sn.rgb, 1.0);
}
