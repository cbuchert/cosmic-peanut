#version 300 es
// Tiled Torus surface: a torus (ring radius 1 about y, tube radius u_k) raymarched from outside
// or from inside the tube, its surface mapped onto the tiling plane by conformal coordinates
// (src/lib/torus.js mirrors and tests the map):
//   p = (lx (θ/2π + fu), ly (t(φ) + fv)),  t(φ) = (1/π) atan(√((1−k)/(1+k)) tan(φ/2))
// lx, ly are periods of the warped, coloured tiling, so it closes around both circles. S comes
// from the ray differential and the analytic gradients of θ and t (no screen derivatives, so
// nothing breaks at the θ = ±π or φ = ±π seams or at the silhouette).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec2 u_lxy;     // plane extents around the ring (lx) and the tube (ly)
uniform float u_ringO;  // ring origin of the figure/ground front, fraction of lx

// Rings run along the tube: 0 at the camera's azimuth, 1 half a turn away, both ways round.
float torusRing(vec2 c) {
  float f = fract(c.x / u_lxy.x - u_ringO + 0.5) - 0.5;
  return clamp(2.0 * abs(f), 0.0, 1.0);
}
#define TESS_RING(c) torusRing(c)

// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec3 u_cam;     // camera position, heading, up (orthonormal heading/up)
uniform vec3 u_fwd;
uniform vec3 u_up;
uniform float u_tan;    // tan of half the vertical field of view
uniform float u_k;      // tube radius (ring radius 1)
uniform vec2 u_flow;    // tile flow (fu, fv), turns
uniform float u_side;   // +1 camera outside the tube, −1 inside
uniform float u_mix;    // 0 outside look … 1 inside look (shading, fog)
uniform float u_fade;   // paper dissolve while the camera crosses the wall
uniform int u_steps;    // march steps

#define PI 3.14159265359

float sdTorus(vec3 p) { return length(vec2(length(p.xz) - 1.0, p.y)) - u_k; }

void main() {
  float hs = 0.5 * u_res.y;
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / hs;
  vec3 right = normalize(cross(u_fwd, u_up));
  vec3 D = u_fwd + (s.x * right + s.y * u_up) * u_tan;   // unnormalized ray
  float dl = length(D);
  vec3 rd = D / dl;
  float pxAng = u_tan / (hs * dl);                      // radians per target px (about)
  float fpx = 1.0 / u_tPxScale;

  // March. Outside: start at the bounding sphere; inside: the wall is all around.
  float t = 0.0;
  float tEnd = 1e9;
  bool hit = false;
  float minPx = 1e9;                                    // closest miss, px (silhouette ink)
  if (u_side > 0.0) {
    float bR = 1.0 + u_k + 0.01;
    float b = dot(u_cam, rd);
    float c = dot(u_cam, u_cam) - bR * bR;
    float h = b * b - c;
    if (h > 0.0) {
      t = max(0.0, -b - sqrt(h));
      tEnd = -b + sqrt(h);
    } else {
      t = 1e9;
    }
  }
  if (t < tEnd) {
    for (int i = 0; i < 160; i++) {
      if (i >= u_steps) break;
      float d = u_side * sdTorus(u_cam + rd * t);
      if (d < 2e-4 * (1.0 + t)) { hit = true; break; }
      minPx = min(minPx, d / max(t * pxAng, 1e-6));
      t += d;
      if (t > tEnd) break;
    }
  }
  // Inside, every ray ends on the wall; one that grazes it (the tube curving away) can run out
  // of steps just short of it: take where it got to.
  if (u_side < 0.0) hit = true;

  vec3 paper = u_tPaper;
  vec3 col;
  if (hit) {
    vec3 X = u_cam + rd * t;
    float rho = length(X.xz);
    float w = rho - 1.0;
    float theta = atan(X.z, X.x);
    float phi = atan(X.y, w);
    float a = sqrt((1.0 - u_k) / (1.0 + u_k));
    float tf = atan(a * sin(0.5 * phi), cos(0.5 * phi)) / PI;
    vec2 p = vec2(u_lxy.x * (theta / (2.0 * PI) + u_flow.x), u_lxy.y * (tf + u_flow.y));

    // S = dp/dX · dX/dpixel. Ray differential on the tangent plane (unnormalized D, X = O + τD).
    vec3 n = vec3(X.x / rho * w, X.y, X.z / rho * w) / u_k;
    float tau = t / dl;
    vec3 dDx = right * (u_tan / hs);
    vec3 dDy = u_up * (u_tan / hs);
    float nD = dot(n, D);
    nD = abs(nD) < 1e-5 ? (nD < 0.0 ? -1e-5 : 1e-5) : nD;
    vec3 dXx = tau * (dDx - D * (dot(n, dDx) / nD));
    vec3 dXy = tau * (dDy - D * (dot(n, dDy) / nD));
    vec3 gTheta = vec3(-X.z, 0.0, X.x) / (rho * rho);
    vec3 gPhi = vec3(-X.y * X.x / rho, w, -X.y * X.z / rho) / (u_k * u_k);
    vec3 gx = (u_lxy.x / (2.0 * PI)) * gTheta;
    vec3 gy = (u_lxy.y * sqrt(1.0 - u_k * u_k) / (2.0 * PI * rho)) * gPhi;
    mat2 S = mat2(dot(gx, dXx), dot(gy, dXx), dot(gx, dXy), dot(gy, dXy));

    col = tessShade(p, S).rgb;

    // Soft light. Outside: from the upper left of the view, a little darker in the hole.
    // Inside: a lamp at the camera; fog down the tube.
    vec3 L = normalize(-u_fwd * 0.5 + u_up * 0.7 - right * 0.5);
    float outLit = (0.64 + 0.42 * max(dot(n, L), 0.0)) * (0.86 + 0.14 * (w / u_k));
    float inLit = 0.62 + 0.45 * abs(dot(n, rd));
    col *= mix(outLit, inLit, u_mix);
    float fog = 1.0 - exp(-t * t * 0.55);
    col = mix(col, mix(paper, u_tAvg, 0.25), fog * u_mix);
  } else {
    // Paper, with the silhouette cut in ink where the ray grazed the torus.
    col = mix(paper, u_tInk, tessBand(minPx, 0.8 * u_tInkW * fpx) * (1.0 - u_mix));
  }
  col = mix(col, paper, u_fade);
  o = vec4(col, 1.0);
}
