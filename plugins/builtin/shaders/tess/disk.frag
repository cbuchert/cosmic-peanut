#version 300 es
// Poincaré Disk surface: the tiling is a {p,q} tiling of the hyperbolic plane, seen in the
// Poincaré disk, its kites warped into interlocking creatures; the engine prints them
// (tessPrint). src/lib/tess-disk.js mirrors every step here and is tested.
//
// Per pixel: the disk point w → the view T (a drifting isometry, rebased on the CPU) → fold into
// the fundamental triangle T, tracking the quotient matrix E (for the colour), the parity, the
// differential (for the print's pixel scale) and the screen centre's image (for the rings) →
// the frame (an odd fold ends with the mirror a, so the frame map is a rotation) → the chart of
// the diamond round the edge midpoint M (translate M to 0, Klein, scale to the square
// [−1, 1]²) → the creature warp (odd under the half-turn about M) → which of the diamond's four
// kites, its uv (a homography per quadrant) and its colour (one texel of the quotient table).
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;
out vec4 o;

// Ring hook: a tile's centre is carried as (its pseudo-distance |w| from the screen centre, 0),
// so its ring is its hyperbolic distance from the centre over u_ringR: fronts spread to the rim.
uniform float u_ringR;
float diskRing(vec2 c) { return clamp(2.0 * atanh(min(c.x, 0.9999999)) / u_ringR, 0.0, 1.0); }
#define TESS_RING(c) diskRing(c)

// #include tess

uniform vec2 u_res;           // target size (px)
uniform vec3 u_disk;          // disk centre (target px), radius (target px)

// #include disk

void main() {
  vec2 w = (gl_FragCoord.xy - u_disk.xy) / u_disk.z;
  float rw = length(w);
  float fpx = 1.0 / u_tPxScale;
  // A kite's size in target px from the disk's metric (2|dw| / (1 − |w|²)): one size per tile
  // for the print's fades, smooth across the kite.
  float tileSize = rw < 1.0 ? 0.5 * u_kiteA * u_disk.z * (1.0 - rw * rw) : 0.0;
  vec3 col = u_tInk;
  // Tiles below about a pixel print as ink (the crowded rim); don't fold for them.
  if (tileSize > 0.6 * fpx) col = mix(u_tInk, diskShade(w, u_disk.z, mat2(1.0), tileSize).rgb, smoothstep(0.6 * fpx, 1.6 * fpx, tileSize));
  // The disk's edge, antialiased, onto the paper.
  col = mix(u_tPaper, col, clamp((1.0 - rw) * u_disk.z + 0.5, 0.0, 1.0));
  o = vec4(col, 1.0);
}
