#version 300 es
// Tiled Torus surface: a torus (ring radius 1 about y, tube radius u_k) raymarched from outside
// or from inside the tube, its surface mapped onto the tiling plane by conformal coordinates
// (src/lib/torus.js mirrors and tests the map):
//   p = (lx (θ/2π + fu), ly (t(φ) + fv + tw θ/2π)),  t(φ) = (1/π) atan(√((1−k)/(1+k)) tan(φ/2))
// lx, ly are periods of the warped, coloured tiling, so it closes around both circles. The spin
// fv rolls the tiles round the tube; the twist tw (a whole number of tile periods per lap, so it
// still closes) streams them round the ring in a helix, the tiles leaning by its shear. The
// spin shifts t, not φ, so the map stays conformal and the tiles stay square.
//
// The waveform deforms it (torus-disp.frag bakes it, src/lib/torus-wave.js mirrors it as
// dispAt): the surface sits at tube distance k + disp(θ, φ), each ring born at the hole
// (φ = ±π) and rolling a full lap round the tube at full height. The tiles keep the
// undisplaced (θ, φ), so they ride the waves (which stay on the geometry: the spin and twist
// move only the tiles); S and the normal come from the displaced surface
// (ray differential × analytic gradients of θ and t: no seams at θ = ±π, φ = ±π or the edge).
//
// Relief (lib/tess-gl.js compiles this with TESS_RELIEF, and TESS_HEIGHT_PASS for the height
// pass; src/lib/torus-relief.js mirrors and tests it): the tiles become the engine's carved
// blocks, riding the waves. The height pass bakes the block's height over the torus's own
// coordinates (a, b) = (θ/2π + fu, t(φ) + fv), so the relief spins and flows with the tiles while
// the waves stay on the geometry; every cut side is leaned to a slope the march can bound. The
// surface then sits at tube distance k + disp + side × rel, the block raised towards the viewer
// (outward outside, inward inside the tube). Above the relief's shell the march steps by the
// waves' bound; inside it by the combined one. The block is printed and lit from the engine's
// own plate (crisp bevels), the leaned cut sides from the map, under the Light param's raking
// light with a short soft shadow.
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

uniform float u_twist;  // turns of t per lap round the ring (whole tile periods: closes)

#ifdef TESS_RELIEF
// Cards turn about an axis across the ring: they squeeze along it, away from the camera's
// azimuth both ways (the radial default would need a ring origin in the plane).
vec2 torusFlipDir(vec2 c) {
  return vec2(fract(c.x / u_lxy.x - u_ringO + 0.5) < 0.5 ? -1.0 : 1.0, 0.0);
}
#define TESS_FLIP_DIR(c) torusFlipDir(c)
// A tile's lift variation and pops hash its cell; across the seams one tile has two cells, so
// hash its copy in one fundamental domain (torus-relief.js cellKey).
vec2 torusCellKey(vec2 cell);
#define TESS_CELL_KEY(cell) torusCellKey(cell)
#endif

// #include tess

#ifdef TESS_RELIEF
vec2 torusCellKey(vec2 cell) {
  if (u_tGroup == 0) {
    // p4: copies (2 lx, 2 tw ly) and (0, 2 ly) apart
    float l1x = 2.0 * u_lxy.x;
    float l1y = floor(2.0 * u_twist * u_lxy.y + 0.5);
    float l2 = 2.0 * u_lxy.y;
    float n1 = floor((cell.x + 0.5) / l1x);
    vec2 k = cell - n1 * vec2(l1x, l1y);
    k.y -= floor((k.y + 0.5) / l2) * l2;
    return k;
  }
  // p3: cell = 3 (a, b) + (class, 0); T1 = (nu − j, 2j), T2 = (−nv, 2nv) in (a, b), j = tw nv
  float nu = u_lxy.x;
  float nv = floor(u_lxy.y / S3 + 0.5);
  float j = floor(u_twist * nv + 0.5);
  float la = floor((cell.x + 0.5) / 3.0);
  float kc = cell.x - 3.0 * la;
  float lb = floor(cell.y / 3.0 + 0.5);
  float n1 = floor((2.0 * la + lb + 0.5) / (2.0 * nu));
  la -= n1 * (nu - j);
  lb -= n1 * 2.0 * j;
  float n2 = floor((lb + 0.5) / (2.0 * nv));
  la += n2 * nv;
  lb -= n2 * 2.0 * nv;
  return vec2(3.0 * la + kc, 3.0 * lb);
}
#endif

uniform vec2 u_res;     // target size (px)
uniform vec3 u_cam;     // camera position, heading, up (orthonormal heading/up)
uniform vec3 u_fwd;
uniform vec3 u_up;
uniform float u_tan;    // tan of half the vertical field of view
uniform float u_k;      // tube radius (ring radius 1)
uniform vec2 u_flow;    // tile flow along the ring (fu) and spin round the tube (fv), turns
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

#ifdef TESS_RELIEF
// Lean every cut side to at most this slope (plane units up per unit across; torus-relief.js
// SLOPE_CAP): the tile's height is capped at it × the distance to its outline.
#define RELIEF_SLOPE 2.0
// Steps a ray may take under the block's local ceiling at the combined (cut-side) factor, the
// steep, slow part of the march. Inside the tube, where every ray grazes a wall, it then stops
// short of the surface and is projected onto it. Outside, a ray that used them is skimming the
// blocks (mostly at the silhouette): it carries on at the waves' factor, so it can pass and be
// inked as a miss; only there may a step clip a cut side's edge.
#define RELIEF_STEPS_IN 24
#define RELIEF_STEPS_OUT 64
// Outside, even steps over the rest of a spent ray's chord when it is still clear of the blocks.
#define SPENT_SEARCH 24
uniform vec4 u_rel;     // world per plane unit on the centre circle (RELIEF_SCALE 2π / lx), cap,
                        // relief shell (world), step factor inside it (reliefStep)
uniform vec2 u_relWin;  // ring window of a step (turns, torus-relief.js ringWindow), STEP_REACH
#ifndef TESS_HEIGHT_PASS
uniform sampler2D u_tHeight;   // the height pass: block height / u_tRelief.z over (a, b), repeating
uniform vec2 u_tHeightTexel;   // 1 / its size
uniform vec3 u_light;          // towards the light, view frame (x right, y up, z towards the camera)

// The map's coordinates: the tiles' own (they flow along the ring and spin round the tube).
vec2 reliefAB(float theta, float tf) { return vec2(theta / (2.0 * PI) + u_flow.x, tf + u_flow.y); }
float reliefH(vec2 ab) { return texture(u_tHeight, ab).r * u_tRelief.z; }
// Plane height → world (torus-relief.js reliefWorld): the local plane scale, capped.
float reliefW(float H, float cphi) { return min(u_rel.y, u_rel.x * (1.0 + u_k * cphi) * H); }
// The tallest the block can be (plane units) on any tile a STEP_REACH step from a point at
// a = θ/2π + fu can touch, from the music alone (torus-relief.js localCeiling): the rings in
// the window's lift bins, the pops whose band reaches them, a card if the front turns them.
float reliefCeiling(float a) {
  float fo = abs(fract(a - u_ringO + 0.5) - 0.5);
  float lo = 2.0 * max(0.0, fo - u_relWin.x);
  float hi = min(1.0, 2.0 * (fo + u_relWin.x));
  float n = float(TESS_LIFT_BINS - 1);
  int i1 = int(min(n, ceil(hi * n)));
  float top = -1e9;
  for (int i = int(floor(lo * n)); i <= i1; i++) top = max(top, u_tLift[i]);
  float pop = 0.0;
  for (int k = 0; k < TESS_POP_SLOTS; k++) {
    vec4 pp = u_tPop[k];
    if (pp.x > 0.0 && lo < pp.y + POP_BAND && hi > pp.y - POP_BAND) pop += pp.x;
  }
  float lifted = top * (top > 0.0 ? 1.0 + LIFT_VARY : 1.0 - LIFT_VARY);
  float hw = 0.5 * u_tInvert.y;
  float card = (lo < u_tInvert.x + hw && hi > u_tInvert.x - hw) ? CARD_RISE * (2.0 * CARD_HALF + u_tRelief.w) : 0.0;
  return max(0.0, u_tRelief.x * (RELIEF_BLOCK + lifted + pop) + card);
}
float relAt(float theta, float phi) {
  float a = sqrt((1.0 - u_k) / (1.0 + u_k));
  float tf = atan(a * sin(0.5 * phi), cos(0.5 * phi)) / PI;
  return reliefW(reliefH(reliefAB(theta, tf)), cos(phi));
}
#endif
#endif

// The waves' displacement, from the map torus-disp.frag bakes each frame (one bilinear tap;
// u = θ / 2π, v = age: laps round the tube from the hole, both wrapping).
float disp(float theta, float phi) {
  vec2 uv = vec2(theta / (2.0 * PI), fract((PI - phi) / (2.0 * PI))) + 0.5 / vec2(textureSize(u_dispMap, 0));
  return u_amp * texture(u_dispMap, uv).r;
}

#ifdef TESS_RELIEF
// The block's height as the height pass bakes it (plane units): each tile capped at RELIEF_SLOPE
// × its distance to its outline over the warp's largest stretch ‖J‖ (so its cut sides lean),
// and a card's bed is the floor.
float jNorm(mat2 J) {
  float tt = dot(J[0], J[0]) + dot(J[1], J[1]);
  float dt = determinant(J);
  return sqrt(0.5 * (tt + sqrt(max(0.0, tt * tt - 4.0 * dt * dt))));
}
float leanedH(TessPlate r) {
  float jn = jNorm(r.J);
  return r.pit > 0.5 ? 0.0 : min(r.h, RELIEF_SLOPE * r.t.dist / max(jn, 1e-6));
}
#endif

#if defined(TESS_RELIEF) && !defined(TESS_HEIGHT_PASS)
// The combined surface's signed distance along the tube's radius (waves + block, raised towards
// the viewer), as the march's innermost tier measures it; outside the displaced shell, the
// undisplaced distance less the shell (a lower bound).
float reliefF(vec3 X) {
  float w = length(X.xz) - 1.0;
  float d0 = u_side * (length(vec2(w, X.y)) - u_k);
  if (d0 > u_dmax) return d0 - u_dmax;
  float th = atan(X.z, X.x);
  float ph = atan(X.y, w);
  return u_side * (length(vec2(w, X.y)) - u_k - disp(th, ph)) - relAt(th, ph);
}
#endif

#ifdef TESS_HEIGHT_PASS
// The block's height over (a, b): texel centres (i + ½) / size, the plane point
// (lx a, ly (b + tw a)), so the map repeats in both and closes like the tiling. Each tile is
// capped at RELIEF_SLOPE × its distance to its outline (over the warp's largest stretch ‖J‖, a
// lower bound of the plane distance): its cut sides lean, it meets the groove floor at its
// outline, and a card's bed is the floor (torus-relief.js bakeHeight).
void main() {
  vec2 ab = gl_FragCoord.xy / u_res;
  TessPlate r = tessPlate(vec2(u_lxy.x * ab.x, u_lxy.y * (ab.y + u_twist * ab.x)));
  o = vec4(leanedH(r) / max(u_tRelief.z, 1e-6), 0.0, 0.0, 1.0);
}
#else
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
#ifdef TESS_RELIEF
  float lastPx = 0.0;                                   // the last sample's miss distance, px
#endif
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
#ifdef TESS_RELIEF
    int near = 0;                                       // steps taken under the block's ceiling
#endif
    float prevR = 0.0;
    float stepLen = 0.0;
    int steps = u_steps;
#ifdef TESS_RELIEF
    // Outside, rays skimming the blocks along the silhouette and the hole's rim need more steps
    // (the march is cheap there: most of the view is paper or a short trace).
    if (u_side > 0.0) steps = 2 * u_steps;
#endif
    for (int i = 0; i < 320; i++) {
      if (i >= steps) break;
      vec3 X = u_cam + rd * t;
      float rho = length(X.xz);
      float w = rho - 1.0;
      float q = length(vec2(w, X.y));
      float d0 = u_side * (q - u_k);
      // half a target pixel; inside, looser with depth (the fog hides it there)
      float eps = max(2e-4, pxAng * t * (0.5 + (u_side < 0.0 ? 6.0 * t * t / (FOG_END * FOG_END) : 0.0)));
      float r;                                          // safe radius
      float est;                                        // distance estimate for the ink
      shell = d0 <= u_dmax + eps;
      float f = d0;
      if (!shell) {
        r = d0 - u_dmax;
        est = d0;
      } else {
#ifdef TESS_RELIEF
        float th = atan(X.z, X.x);
        float ph = atan(X.y, w);
        f = u_side * (q - u_k - disp(th, ph));
        if (f > u_rel.z + eps) {
          r = (f - u_rel.z) * u_stepK;                  // above the relief: the waves' bound
          est = f - relAt(th, ph);                      // the silhouette ink's miss distance
        } else {
          // Above the block's local ceiling the waves' bound still holds, for a short step.
          float relUp = reliefW(min(reliefCeiling(th / (2.0 * PI) + u_flow.x), u_tRelief.z), 1.0);
          if (f > relUp + eps) {
            r = min(u_relWin.y, (f - relUp) * u_stepK);
            est = f - relAt(th, ph);
          } else {
            f -= relAt(th, ph);                         // the block, raised towards the camera
            r = f * (near < RELIEF_STEPS_OUT ? u_rel.w : u_stepK);
            if (omega > 1.0) omega = 1.8;               // its bound is loose: relax harder (a
                                                        // failed step still backs into the last sphere)
            est = f;
            near++;
          }
        }
#else
        f = u_side * (q - u_k - disp(atan(X.z, X.x), atan(X.y, w)));
        r = f * u_stepK;
        est = f;
#endif
      }
#ifdef TESS_RELIEF
      // every sample is a point of the ray: the closest miss counts failed relaxed steps too
      // (under the block they fail often, and those are the grazing samples)
      minPx = min(minPx, est / max(t * pxAng, 1e-6));
      lastPx = est / max(t * pxAng, 1e-6);
#endif
      bool fail = omega > 1.0 && r + prevR < stepLen;
      if (fail) {
        stepLen -= omega * stepLen;
        omega = 1.0;
      } else {
        if (shell && f < eps) {
          hit = true;
#ifdef TESS_RELIEF
          // Past its budget an outside ray steps by the waves' bound, which can carry it through
          // a cut side's edge into the block: bisect back to where it crossed (the edge a full
          // march stops on) instead of shading the point it landed on.
          if (near > RELIEF_STEPS_OUT && f < -eps && stepLen > 0.0) {
            float ta = t - stepLen;
            for (int j = 0; j < 6; j++) {
              float tm = 0.5 * (ta + t);
              if (reliefF(u_cam + rd * tm) < 0.0) t = tm; else ta = tm;
            }
          }
#endif
          break;
        }
        stepLen = max(r, 0.5 * eps) * omega;
        minPx = min(minPx, est / max(t * pxAng, 1e-6));
      }
      prevR = r;
      t += stepLen;
      if (t > tEnd) break;
#ifdef TESS_RELIEF
      // A ray creeping along the block (grazing a cut side or a groove) stops after its budget,
      // short of the surface but never past it, and is projected onto it below like a ray that
      // ran out of steps.
      if (u_side < 0.0 && near >= RELIEF_STEPS_IN) break;
#endif
    }
  }
#ifdef TESS_RELIEF
  // Outside, a ray that skims the blocks (along the silhouette, over the hole's near lip) can
  // spend its steps still pixels above them. Projecting it onto the surface and inking it drew
  // thin ink arcs past the silhouette. Instead, search the rest of its chord through the
  // bounding sphere in even steps for a crossing (the far wall of the hole), bisect it, and
  // shade it as a hit; with none, it is a miss and the silhouette ink comes from its closest
  // approach as for any other miss.
  if (!hit && u_side > 0.0 && shell && t < tEnd && lastPx > 1.0) {
    float ta = t;
    float dt = (tEnd - t) / float(SPENT_SEARCH);
    for (int i = 1; i <= SPENT_SEARCH; i++) {
      float tb = t + float(i) * dt;
      if (reliefF(u_cam + rd * tb) < 0.0) {
        for (int j = 0; j < 6; j++) {
          float tm = 0.5 * (ta + tb);
          if (reliefF(u_cam + rd * tm) < 0.0) tb = tm; else ta = tm;
        }
        t = tb;
        hit = true;
        break;
      }
      ta = tb;
    }
    shell = false;                                      // not spent: a hit or a miss
  }
#endif
  // A ray that grazes the surface can run out of steps in the shell, just short of it: put its
  // end on the displaced surface (radially in the tube's cross-section) and shade that point, so
  // the fallback is still a point of the surface (inside, every ray ends on the wall).
  vec3 X = u_cam + rd * t;
  bool spent = false;                                   // ran out of steps in the shell
  if (!hit && (u_side < 0.0 || (shell && t < tEnd))) {
    hit = true;
    spent = true;
    if (shell) {
      float rho = length(X.xz);
      vec3 c = vec3(X.x / rho, 0.0, X.z / rho);
      vec3 rad = X - c;
      float q = length(rad);
      if (q > 1e-4) {
#ifdef TESS_RELIEF
        float th = atan(X.z, X.x);
        float ph = atan(X.y, rho - 1.0);
        X = c + rad / q * (u_k + disp(th, ph) + u_side * relAt(th, ph));
#else
        X = c + rad / q * (u_k + disp(atan(X.z, X.x), atan(X.y, rho - 1.0)));
#endif
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
    vec2 p = vec2(u_lxy.x * (theta / (2.0 * PI) + u_flow.x), u_lxy.y * (tf + u_flow.y + u_twist * theta / (2.0 * PI)));

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
    vec3 gy = (u_lxy.y * sqrt(1.0 - u_k * u_k) / (2.0 * PI * (1.0 + u_k * cos(phi)))) * gPhi
            + (u_lxy.y * u_twist / (2.0 * PI)) * gTheta;
    mat2 S = mat2(dot(gx, dXx), dot(gy, dXx), dot(gx, dXy), dot(gy, dXy));

#ifdef TESS_RELIEF
    // The block: printed from the engine's plate at p (S from the waves' tangent plane), its
    // slope from the plate where the map follows it, from the map on the cut sides the height
    // pass leaned (there the map is lower than the plate).
    TessPlate pl;
    float detail;
    col = tessShadeRelief(p, S, pl, detail).rgb;
    vec2 ab = reliefAB(theta, tf);
    float Hm = reliefH(ab);
    float cphi = w / q;
    float sc = u_rel.x * (1.0 + u_k * cphi);              // world per plane unit here
    vec3 gH = pl.grad.x * gx + pl.grad.y * gy;           // ∇H, world, from the plate
    // The leaned cut sides from the exact block the map was baked from, not from its bilinear
    // texels (a close view spreads one over ~20 px, which made the sides ragged): where the cap
    // holds, the side's slope is the cap's, RELIEF_SLOPE along the outline distance's gradient.
    float wall = smoothstep(0.002, 0.012, pl.h - leanedH(pl));
    if (wall > 0.0) {
      vec2 gc = (RELIEF_SLOPE / max(jNorm(pl.J), 1e-6)) * (transpose(pl.J) * pl.t.n);
      gH = mix(gH, gc.x * gx + gc.y * gy, wall);
      col *= 1.0 - 0.4 * wall;                           // a cut side, in the shade of its top
    }
    bool capped = sc * Hm >= u_rel.y;
    vec3 gRel = capped ? vec3(0.0) : sc * gH - (u_rel.x * u_k * X.y / q * Hm) * gPhi;
    vec3 nR = normalize(n0 - gDisp - u_side * gRel);     // the block on the waves
    float relH = reliefW(Hm, cphi);

    // The Light param's raking light (view frame → world), for the waves' and the block's tilt,
    // a short soft shadow cast by the lifted blocks, and darker grooves.
    vec3 L = normalize(u_light.x * right + u_light.y * u_up - u_light.z * u_fwd);
    float outLit = (0.64 + 0.42 * max(dot(nR, L), 0.0)) * (0.86 + 0.14 * (w / q));
    float inLit = 0.62 + 0.45 * abs(dot(nR, rd));
    float relief = dot(nR - n0, L) * (u_side > 0.0 ? 1.0 : -1.0);
    float shadow = 1.0;
    float facing = dot(L, n0) * u_side;
    if (u_rel.z > 1e-5 && facing > 0.05) {
      float reach = max(u_rel.z - relH, 0.0) / max(facing, 0.25);
      float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      for (int i = 1; i <= 4; i++) {
        float st = reach * (float(i) - jit) / 4.0 + 1e-3;
        vec3 Y = X + L * st;
        float ry = length(Y.xz);
        float wy = ry - 1.0;
        float th = atan(Y.z, Y.x);
        float ph = atan(Y.y, wy);
        float clear = u_side * (length(vec2(wy, Y.y)) - u_k - disp(th, ph)) - relAt(th, ph);
        shadow = min(shadow, clamp(0.5 + 6.0 * clear / st, 0.0, 1.0));
      }
      shadow = smoothstep(0.0, 1.0, shadow);
    }
    float top = max(u_tRelief.x * RELIEF_BLOCK, 1e-4);
    float ao = 0.8 + 0.2 * smoothstep(0.0, top, Hm);
    col *= mix(outLit, inLit, u_mix) * clamp(1.0 + 1.8 * relief, 0.45, 1.5) * (0.5 + 0.5 * shadow) * ao;
    // Outside, a ray that skims the blocks along the silhouette can run out of steps before it
    // passes them; it is projected onto the surface like any spent ray, and inked as the
    // outline it is grazing (the misses beyond ink the other side).
    if (spent && u_side > 0.0) col = mix(col, u_tInk, 1.0 - u_mix);
#else
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
#endif

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
#endif
