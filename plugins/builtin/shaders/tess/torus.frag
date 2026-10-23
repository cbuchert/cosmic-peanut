#version 300 es
// Tiled Torus surface: a torus (ring radius 1 about y, tube radius u_k) raymarched from outside
// or from inside the tube, its surface mapped onto the tiling plane by conformal coordinates
// (src/lib/torus.js mirrors and tests the map):
//   p = (lx (θ/2π + fu), ly (t(φ) + fv)),  t(φ) = (1/π) atan(√((1−k)/(1+k)) tan(φ/2))
// lx, ly are periods of the warped, coloured tiling, so it closes around both circles.
//
// The waveform deforms it (torus-disp.frag bakes it, src/lib/torus-wave.js mirrors it as
// dispAt): the surface sits at tube distance k + disp(θ, φ), each ring born at the hole
// (φ = ±π) and rolling a full lap round the tube at full height. The tiles keep the
// undisplaced (θ, φ), so they ride the waves; S and the normal come from the displaced surface
// (ray differential × analytic gradients of θ and t: no seams at θ = ±π, φ = ±π or the edge).
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

uniform sampler2D u_dispMap; // torus-disp.frag: displacement over (θ / 2π, age), stored units
uniform float u_amp;    // world displacement per stored unit
uniform float u_dmax;   // |disp| ≤ this
uniform float u_stepK;  // Lipschitz-safe step factor in the displaced shell (torus-wave stepFactor)

#define PI 3.14159265359
// Inside, the fog reaches the paper haze completely at this distance; rays stop there.
#define FOG_END 2.6

// The waves' displacement, from the map torus-disp.frag bakes each frame (one bilinear tap;
// u = θ / 2π, v = age: laps round the tube from the hole, both wrapping).
float disp(float theta, float phi) {
  vec2 uv = vec2(theta / (2.0 * PI), fract((PI - phi) / (2.0 * PI))) + 0.5 / vec2(textureSize(u_dispMap, 0));
  return u_amp * texture(u_dispMap, uv).r;
}

void main() {
  float hs = 0.5 * u_res.y;
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / hs;
  vec3 right = normalize(cross(u_fwd, u_up));
  vec3 D = u_fwd + (s.x * right + s.y * u_up) * u_tan;   // unnormalized ray
  float dl = length(D);
  vec3 rd = D / dl;
  float pxAng = u_tan / (hs * dl);                      // radians per target px (about)
  float fpx = 1.0 / u_tPxScale;

  // March. Outside: start at the bounding sphere; inside: the wall is all around. Away from
  // the displaced shell (|sdTorus| > dmax) the undisplaced distance minus dmax is an exact lower
  // bound; inside the shell, f = sdTorus − disp stepped by the Lipschitz factor.
  float t = 0.0;
  float tEnd = 1e9;
  bool hit = false;
  bool shell = false;
  float minPx = 1e9;                                    // closest miss, px (silhouette ink)
  if (u_side < 0.0) tEnd = FOG_END;                     // inside: past this it is all fog
  if (u_side > 0.0) {
    float bR = 1.0 + u_k + u_dmax + 0.01;
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
    // Over-relaxed sphere tracing (Keinert et al. 2014): step ω × the safe radius; if the new
    // safe sphere and the last one don't overlap, the step may have jumped the surface, so go
    // back inside the last safe sphere and continue unrelaxed.
    float omega = 1.5;
    float prevR = 0.0;
    float stepLen = 0.0;
    for (int i = 0; i < 320; i++) {
      if (i >= u_steps) break;
      vec3 X = u_cam + rd * t;
      float rho = length(X.xz);
      float w = rho - 1.0;
      float q = length(vec2(w, X.y));
      float d0 = u_side * (q - u_k);
      float eps = max(2e-4, 0.5 * pxAng * t);           // half a target pixel
      float r;                                          // safe radius
      float est;                                        // distance estimate for the ink
      shell = d0 <= u_dmax + eps;
      float f = d0;
      if (!shell) {
        r = d0 - u_dmax;
        est = d0;
      } else {
        f = u_side * (q - u_k - disp(atan(X.z, X.x), atan(X.y, w)));
        r = f * u_stepK;
        est = f;
      }
      bool fail = omega > 1.0 && r + prevR < stepLen;
      if (fail) {
        stepLen -= omega * stepLen;
        omega = 1.0;
      } else {
        if (shell && f < eps) { hit = true; break; }
        stepLen = max(r, 0.5 * eps) * omega;
        minPx = min(minPx, est / max(t * pxAng, 1e-6));
      }
      prevR = r;
      t += stepLen;
      if (t > tEnd) break;
    }
  }
  // A ray that grazes the surface can run out of steps in the shell, just short of it: put its
  // end on the displaced surface (radially in the tube's cross-section) and shade that point, so
  // the fallback is still a point of the surface (inside, every ray ends on the wall).
  vec3 X = u_cam + rd * t;
  if (!hit && (u_side < 0.0 || (shell && t < tEnd))) {
    hit = true;
    if (shell) {
      float rho = length(X.xz);
      vec3 c = vec3(X.x / rho, 0.0, X.z / rho);
      vec3 rad = X - c;
      float q = length(rad);
      if (q > 1e-4) {
        X = c + rad / q * (u_k + disp(atan(X.z, X.x), atan(X.y, rho - 1.0)));
        t = length(X - u_cam);
      }
    }
  }

  vec3 paper = u_tPaper;
  vec3 col;
  if (hit) {
    float rho = length(X.xz);
    float w = rho - 1.0;
    float q = max(length(vec2(w, X.y)), 1e-4);
    float theta = atan(X.z, X.x);
    float phi = atan(X.y, w);
    float a = sqrt((1.0 - u_k) / (1.0 + u_k));
    float tf = atan(a * sin(0.5 * phi), cos(0.5 * phi)) / PI;
    vec2 p = vec2(u_lxy.x * (theta / (2.0 * PI) + u_flow.x), u_lxy.y * (tf + u_flow.y));

    // Gradients of the parameters, the displacement and the displaced surface's normal.
    vec3 gTheta = vec3(-X.z, 0.0, X.x) / (rho * rho);
    vec3 gPhi = vec3(-X.y * X.x / rho, w, -X.y * X.z / rho) / (q * q);
    vec3 n0 = vec3(X.x / rho * w, X.y, X.z / rho * w) / q;
    float hd = 0.004;
    float dc = disp(theta, phi);
    float dTh = (disp(theta + hd, phi) - dc) / hd;       // one-sided: the waves are rounded
    float dPh = (disp(theta, phi + hd) - dc) / hd;
    vec3 gDisp = dTh * gTheta + dPh * gPhi;
    vec3 n = normalize(n0 - gDisp);

    // S = dp/dX · dX/dpixel. Ray differential on the tangent plane (unnormalized D, X = O + τD).
    float tau = t / dl;
    vec3 dDx = right * (u_tan / hs);
    vec3 dDy = u_up * (u_tan / hs);
    float nD = dot(n, D);
    nD = abs(nD) < 1e-5 ? (nD < 0.0 ? -1e-5 : 1e-5) : nD;
    vec3 dXx = tau * (dDx - D * (dot(n, dDx) / nD));
    vec3 dXy = tau * (dDy - D * (dot(n, dDy) / nD));
    vec3 gx = (u_lxy.x / (2.0 * PI)) * gTheta;
    vec3 gy = (u_lxy.y * sqrt(1.0 - u_k * u_k) / (2.0 * PI * (1.0 + u_k * cos(phi)))) * gPhi;
    mat2 S = mat2(dot(gx, dXx), dot(gy, dXx), dot(gx, dXy), dot(gy, dXy));

    col = tessShade(p, S).rgb;

    // Soft light. Outside: from the upper left of the view, a little darker in the hole.
    // Inside: a lamp at the camera; fog down the tube. A raking light reads the waves' relief
    // (the tilt of the displaced normal against the undisplaced one).
    vec3 L = normalize(-u_fwd * 0.5 + u_up * 0.7 - right * 0.5);
    float outLit = (0.64 + 0.42 * max(dot(n, L), 0.0)) * (0.86 + 0.14 * (w / q));
    float inLit = 0.62 + 0.45 * abs(dot(n, rd));
    vec3 Lr = normalize(u_up * 0.8 - right * 0.6 - u_fwd * 0.15);
    float relief = dot(n - n0, Lr) * (u_side > 0.0 ? 1.0 : -1.0);
    col *= mix(outLit, inLit, u_mix) * clamp(1.0 + 1.8 * relief, 0.45, 1.5);

    // Woodcut crests: ink contours of the displacement at two heights.
    vec2 dpx = vec2(dot(gDisp, dXx), dot(gDisp, dXy));
    float gpx = max(length(dpx), 1e-6);
    float crest = max(tessBand((dc - 0.9 * u_amp) / gpx, 0.5 * u_tInkW * fpx),
                      tessBand((dc - 1.7 * u_amp) / gpx, 0.5 * u_tInkW * fpx));
    col = mix(col, u_tInk, crest * smoothstep(0.02, 0.2, u_amp / max(u_k, 1e-3)));

    float fog = clamp((1.0 - exp(-t * t * 0.55)) / (1.0 - exp(-FOG_END * FOG_END * 0.55)), 0.0, 1.0);
    col = mix(col, mix(paper, u_tAvg, 0.25), fog * u_mix);
  } else {
    // Paper, with the silhouette cut in ink where the ray grazed the torus.
    col = mix(paper, u_tInk, tessBand(minPx, 0.8 * u_tInkW * fpx) * (1.0 - u_mix));
  }
  col = mix(col, paper, u_fade);
  o = vec4(col, 1.0);
}
