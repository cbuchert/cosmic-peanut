#version 300 es
// Endless Zoom: the tiling seen through a log-polar map, p = α log z + O, so it spirals into the
// vanishing point without end. One turn round the centre moves p by the lattice vector α·2πi
// (src/lib/tess-zoom.js spiralVector), so the tiles close across the angle's seam; zooming slides
// O along α. S is the map's analytic Jacobian (α / z per px), not dFdx, which would see the seam.
precision highp float;

in vec2 v_uv;
out vec4 o;

uniform vec2 u_O;       // plane offset (wrapped by whole blend periods)
uniform vec2 u_alpha;   // complex scale α
uniform vec3 u_ring;    // ring span in log radius: lo, hi; 1 = flip (edge → centre)

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// A tile's ring by the log radius of its centre: Re((c − O) / α). Constant round each turn,
// so it agrees across the seam; fronts ripple along the spiral.
float zoomRing(vec2 c) {
  float lr = dot(c - u_O, u_alpha) / dot(u_alpha, u_alpha);
  float r = clamp((lr - u_ring.x) / (u_ring.y - u_ring.x), 0.0, 1.0);
  return u_ring.z > 0.5 ? 1.0 - r : r;
}
#define TESS_RING(c) zoomRing(c)

// #include tess

uniform vec2 u_res;     // target size (px)
uniform vec2 u_vp;      // vanishing point, screen units (half the short side) from the centre
uniform vec3 u_vanish;  // soft vanishing point: inner, outer radius (screen units); 0 ink … 1 paper

void main() {
  float hs = 0.5 * min(u_res.x, u_res.y);
  vec2 z = (gl_FragCoord.xy - 0.5 * u_res) / hs - u_vp;
  float r2 = max(dot(z, z), 1e-12);
  vec2 w = vec2(0.5 * log(r2), atan(z.y, z.x));
  vec2 az = cmul(u_alpha, vec2(z.x, -z.y)) / (r2 * hs); // dp/dpixel = α / z / hs
  o = tessShade(cmul(u_alpha, w) + u_O, mat2(az.x, az.y, -az.y, az.x));
  // Tiles too small to print fade (in the engine) to their mean; then into a soft point.
  float k = 1.0 - smoothstep(u_vanish.x, u_vanish.y, sqrt(r2));
  o.rgb = mix(o.rgb, mix(u_tInk, u_tPaper, u_vanish.z), k * k);
}
