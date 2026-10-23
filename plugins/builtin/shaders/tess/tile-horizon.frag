#version 300 es
// Tile Horizon, floor surface: the tiling is an endless plane (z = 0) seen from a camera gliding
// low over it. Each pixel's ray meets the plane at p; S = dp/dpixel comes from the derivatives,
// so ink stays a constant weight in pixels however far the plane recedes. Towards the horizon
// the floor fades into the paper, by distance (fog) and by footprint (before a tile is too few
// pixels along its most foreshortened side to print without aliasing).
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec3 u_cam;     // camera ground position (xy, plane units) and height
uniform float u_ringR;  // ground distance of ring 1

// Rings by distance from the camera: figure/ground fronts sweep outwards across the floor.
float floorRing(vec2 c) { return clamp(length(c - u_cam.xy) / u_ringR, 0.0, 1.0); }
#define TESS_RING(c) floorRing(c)

// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec3 u_fwd;     // view basis (world): forward, right, up
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_focal;  // focal length, half-short-side units
uniform float u_fog;    // ground distance where the floor is paper

void main() {
  float hs = 0.5 * min(u_res.x, u_res.y);
  vec2 s = (gl_FragCoord.xy - 0.5 * u_res) / hs;
  vec3 d = u_fwd * u_focal + u_right * s.x + u_up * s.y;
  float down = -d.z;
  // Computed for every pixel (sky too) so the derivatives stay defined across the horizon.
  float t = u_cam.z / max(down, 1e-4);
  vec2 p = u_cam.xy + t * d.xy;
  mat2 S = mat2(dFdx(p), dFdy(p));
  float dist = t * length(d.xy);
  float fp = max(length(S[0]), length(S[1]));       // plane units per px, worst axis
  float fogA = 1.0 - exp(-3.0 * (dist / u_fog) * (dist / u_fog));
  float footA = smoothstep(0.5 / 16.0, 0.5 / 5.0, fp); // half-unit tile under 16 → 5 px
  float a = down <= 0.0 ? 1.0 : max(fogA, footA);
  if (a > 0.995) {
    o = vec4(u_tPaper, 1.0);
    return;
  }
  vec4 c = tessShade(p, S);
  o = vec4(mix(c.rgb, u_tPaper, a), 1.0);
}
