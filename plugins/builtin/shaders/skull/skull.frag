// Skull Trip: the candy-apple red metal skull, raymarched inside its bounding circle only.
// Prepended at load: #version, precision, the shape table (lib/skull-bounds.js glslDefines) and
// opart.glsl. Output: premultiplied colour, alpha = coverage (anti-aliased silhouette).

in vec2 v_uv;
out vec4 o_color;

uniform mat3 u_rot;      // object-from-world rotation (nod, turn, tilt)
uniform float u_scale;   // skull size × bass pulse
uniform float u_focal;   // camera focal length (screen units)
uniform float u_camDist; // lib/skull-bounds.js CAM_DIST
uniform float u_circle;  // bounding circle radius on screen (lib/skull-bounds.js screenRadius)
uniform float u_jaw;     // jaw opening, radians
uniform float u_eyeSpin; // eye whirlpool angle
uniform float u_pixel;   // one pixel of this pass, in screen units

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}

// A row of teeth on an arc of radius `arc` round centre c (in the xz plane), facing +z.
float sdTeeth(vec3 p, vec3 c, float arc) {
  vec3 q = p - c;
  float a = atan(q.x, q.z);
  float id = clamp(floor(a / TOOTH_STEP + 0.5), -TOOTH_SIDE, TOOTH_SIDE);
  q.xz = rot2(q.xz, id * TOOTH_STEP);
  q.z -= arc;
  // Front teeth a little taller, back ones smaller.
  float s = 1.0 - 0.07 * abs(id);
  return sdRoundBox(q, TOOTH * vec3(1.0, s, 1.0), TOOTH_ROUND);
}

// Skull without the jaw. m = mirrored point (x ≥ 0).
float sdCranium(vec3 p) {
  vec3 m = vec3(abs(p.x), p.yz);
  float d = sdEllipsoid(p - CRANIUM_C, CRANIUM_R);
  d = smin(d, sdEllipsoid(p - BROWFACE_C, BROWFACE_R), 0.2);
  float maxilla = sdEllipsoid(p - MAXILLA_C, MAXILLA_R);
  maxilla = max(maxilla, -0.56 - p.y); // flat underside above the teeth
  d = smin(d, maxilla, 0.18);
  d = smin(d, sdEllipsoid(m - CHEEK_C, CHEEK_R), 0.12);
  d = smin(d, sdCapsule(m, ARCH_A, ARCH_B, ARCH_R), 0.1);
  d = smin(d, sdCapsule(m, BROW_A, BROW_B, BROW_R), 0.08);
  d = smax(d, -sdEllipsoid(m - TEMPLE_C, TEMPLE_R), 0.15);
  d = smax(d, -sdEllipsoid(m - SOCKET_C, SOCKET_R), 0.05);
  float nose = min(sdEllipsoid(m - NOSE_LOBE_C, NOSE_LOBE_R), sdEllipsoid(p - NOSE_TIP_C, NOSE_TIP_R));
  d = smax(d, -nose, 0.03);
  d = smin(d, sdTeeth(p, TEETH_UP_C, TEETH_UP_ARC), 0.015);
  return d;
}

vec3 toJaw(vec3 p) {
  vec3 q = p - JAW_HINGE;
  float c = cos(u_jaw);
  float s = sin(u_jaw);
  // Inverse of lib/skull-bounds.js jawToWorld.
  return JAW_HINGE + vec3(q.x, q.y * c + q.z * s, -q.y * s + q.z * c);
}

float sdJaw(vec3 p) {
  vec3 j = toJaw(p);
  vec3 m = vec3(abs(j.x), j.yz);
  float d = sdEllipsoid(j - CHIN_C, CHIN_R);
  d = smin(d, sdCapsule(m, JAW_BODY_A, JAW_BODY_B, JAW_BODY_R), 0.1);
  d = smin(d, sdCapsule(m, RAMUS_A, RAMUS_B, RAMUS_R), 0.08);
  d = smin(d, sdTeeth(j, TEETH_DOWN_C, TEETH_DOWN_ARC), 0.015);
  return d;
}

float map(vec3 p) {
  // The jaw never reaches above y = -0.3 (its ramus tops out below the hinge at any angle), so
  // well above that a lower bound on its distance will do and it isn't evaluated.
  float jaw = p.y > 0.0 ? p.y + 0.3 : sdJaw(p);
  return min(sdCranium(p), jaw);
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.002;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                   k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 1; i <= 3; i++) {
    float h = 0.06 * float(i);
    occ += (h - map(p + n * h)) * w;
    w *= 0.6;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

// The stripe pattern seen along a reflected direction: the swirling stripes slide over the metal.
vec3 envStripes(vec3 r, vec2 screen) {
  vec2 uv = r.xy / (1.0 + abs(r.z)) * 1.4 + screen * 0.35;
  float s = opStripe(opPhase(uv, false));
  return mix(u_ink, u_paper, s);
}

// Eye socket whirlpool: a spinning spiral in socket-local coordinates.
vec3 eyeWhirl(vec3 o) {
  vec3 m = vec3(abs(o.x), o.yz);
  vec2 e = (m.xy - SOCKET_C.xy) / SOCKET_R.xy;
  float r = length(e);
  float a = atan(e.y, e.x) * sign(o.x + 1e-4);
  float ph = 3.0 * a + 9.0 * log(max(r, 0.02)) * 1.0 + u_eyeSpin;
  float v = sin(ph);
  float w = max(fwidth(v) * 0.75, 1e-3);
  float s = clamp(0.5 + v / (2.0 * w), 0.0, 1.0);
  // Fade to grey where the spiral gets too fine to resolve (the centre).
  s = mix(0.5, s, smoothstep(0.03, 0.18, r));
  return mix(u_ink, u_paper, s);
}

void main() {
  vec2 p = (v_uv * 2.0 - 1.0) * u_view;
  float rp = length(p);
  if (rp > u_circle + 2.0 * u_pixel) {
    o_color = vec4(0.0);
    return;
  }

  // World: camera on +z looking at the origin. Object: rotate, then unscale.
  vec3 roW = vec3(0.0, 0.0, u_camDist);
  vec3 rdW = normalize(vec3(p, -u_focal));
  vec3 ro = u_rot * roW / u_scale;
  vec3 rd = u_rot * rdW;

  // Clip the march to the bounding sphere.
  float b = dot(ro, rd);
  float c = dot(ro, ro) - SKULL_RADIUS * SKULL_RADIUS;
  float disc = b * b - c;
  if (disc < 0.0) {
    o_color = vec4(0.0);
    return;
  }
  float sq = sqrt(disc);
  float t = max(-b - sq, 0.0);
  float tEnd = -b + sq;

  // Cone width per unit distance, for the silhouette's anti-aliasing (object units).
  float cone = u_pixel / u_focal;
  float best = 1e9;
  float tBest = t;
  bool hit = false;
  for (int i = 0; i < 88; i++) {
    float d = map(ro + rd * t);
    float ratio = d / (cone * t);
    if (ratio < best) {
      best = ratio;
      tBest = t;
    }
    if (d < 0.0006 * t) {
      hit = true;
      break;
    }
    t += d * 0.85;
    if (t > tEnd) break;
  }
  float cover = hit ? 1.0 : clamp(1.0 - best, 0.0, 1.0);
  if (cover <= 0.0) {
    o_color = vec4(0.0);
    return;
  }

  vec3 pos = ro + rd * tBest;
  vec3 n = calcNormal(pos);
  vec3 v = -rd;
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  vec3 r = reflect(rd, n);
  // Back to world space for the environment and lights (u_rot is orthonormal).
  vec3 nW = n * u_rot;
  vec3 rW = r * u_rot;
  float ao = ambientOcclusion(pos, n);

  vec3 env = envStripes(rW, p);
  vec3 red = vec3(0.86, 0.035, 0.03);
  // Candy apple: a red-tinted metallic reflection under a clear coat.
  float fres = pow(1.0 - ndv, 5.0);
  vec3 metal = env * red * (0.55 + 0.45 * ndv) + red * 0.07;
  vec3 coat = mix(vec3(0.04), vec3(1.0), fres) * env;
  vec3 col = metal + coat * 0.9;

  // Key light top-left, fill from the right: sharp clear-coat highlights.
  vec3 key = normalize(vec3(-0.5, 0.7, 0.6));
  vec3 fill = normalize(vec3(0.7, -0.1, 0.5));
  vec3 vW = v * u_rot;
  float sk = pow(max(dot(reflect(-key, nW), vW), 0.0), 60.0);
  float sf = pow(max(dot(reflect(-fill, nW), vW), 0.0), 24.0);
  col += vec3(1.0, 0.95, 0.9) * sk * 1.4 + vec3(1.0, 0.5, 0.4) * sf * 0.35;
  col += red * 0.35 * max(dot(nW, key), 0.0);

  // Yellow edge highlight, strongest on the silhouette and upward-facing rims.
  float rim = pow(1.0 - ndv, 3.0) * (0.6 + 0.4 * max(nW.y, 0.0));
  col += vec3(1.0, 0.78, 0.12) * rim * 0.95;
  col *= mix(0.35, 1.0, ao);

  // Inside the eye sockets: a spinning whirlpool of stripes, shaded by the socket's depth.
  vec3 mpos = vec3(abs(pos.x), pos.yz);
  float sock = sdEllipsoid(mpos - SOCKET_C, SOCKET_R);
  float inSocket = 1.0 - smoothstep(-0.03, 0.012, sock);
  // The socket's rolled lip falls into shadow, so it reads as a hollow, not a lens.
  col *= mix(0.25, 1.0, smoothstep(0.0, 0.09, sock));
  if (inSocket > 0.0) {
    // Hollow: the whirlpool glows from deep inside, falling off into shadow at the socket's lip.
    vec2 e = (mpos.xy - SOCKET_C.xy) / SOCKET_R.xy;
    float lip = smoothstep(1.0, 0.55, length(e));
    vec3 whirl = eyeWhirl(pos) * (0.15 + 0.85 * lip) * (0.5 + 0.5 * ao);
    col = mix(col, whirl, inSocket);
  }
  // The nasal cavity: deep shadow.
  float nose = min(sdEllipsoid(mpos - NOSE_LOBE_C, NOSE_LOBE_R), sdEllipsoid(pos - NOSE_TIP_C, NOSE_TIP_R));
  col *= mix(0.12, 1.0, smoothstep(-0.01, 0.03, nose));

  o_color = vec4(col * cover, cover);
}
