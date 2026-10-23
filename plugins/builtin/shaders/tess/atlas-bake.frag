#version 300 es
// The atlas bake: one period cell of a bestiary tiling (lib/bestiary.js), rendered into two
// RGBA16F textures that the print pass samples (shaders/tess/atlas.glsl). Each texel is a point
// f of the cell in lattice coordinates [0, 1)²; it finds the tile copy holding it, then writes
//   o0: distance to the tile's outline (plane units), its unit gradient (inward), height
//   o1: distance to the nearest visible edge of the interior art (plane units), its unit
//       gradient (away from the edge), and the packed id: (copy·25 + (di+2)·5 + (dj+2))·8 + role
// Runs only when the tile changes (lib/atlas-gl.js). Data layout: lib/atlas.js.
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_uv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;

#define MAX_OUT 512
#define MAX_PRIMS 96
#define MAX_PTS 256
#define DATA_W 512

uniform sampler2D u_bData;  // RGBA32F, NEAREST
uniform int u_bN;           // outline points (data row 0)
uniform mat2 u_bL;          // lattice → tile frame
uniform int u_bCopies;
uniform vec4 u_bInv[4];     // per copy: world → base frame, column-major
uniform vec4 u_bOff[4];     // per copy: offset xy, class, 0
uniform ivec4 u_bRange[4];  // per copy: di from, to, dj from, to
uniform vec4 u_bBox;        // outline box (base frame)
uniform ivec2 u_bSetA;      // art: first header texel, primitives
uniform ivec2 u_bSetB;
uniform vec2 u_bErode;      // erosion of set A, B (tile frame)
uniform float u_bScale;     // plane units per tile-frame unit
uniform float u_bDome;
uniform vec2 u_bRes;        // target size

vec4 dataAt(int t) { return texelFetch(u_bData, ivec2(t % DATA_W, t / DATA_W), 0); }

// Even-odd inside test of p against the outline.
bool insideOutline(vec2 p) {
  bool c = false;
  vec2 b = dataAt(u_bN - 1).xy;
  for (int i = 0; i < MAX_OUT; i++) {
    if (i >= u_bN) break;
    vec2 a = dataAt(i).xy;
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
    b = a;
  }
  return c;
}

// Distance to the outline, and the unit vector from its nearest point to p.
float outlineDist(vec2 p, out vec2 dir) {
  float best = 1e9;
  vec2 bv = vec2(0.0, 1.0);
  vec2 b = dataAt(u_bN - 1).xy;
  for (int i = 0; i < MAX_OUT; i++) {
    if (i >= u_bN) break;
    vec2 a = dataAt(i).xy;
    vec2 ab = a - b;
    vec2 pb = p - b;
    float h = clamp(dot(pb, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    vec2 v = pb - ab * h;
    float d = dot(v, v);
    if (d < best) { best = d; bv = v; }
    b = a;
  }
  float d = sqrt(best);
  dir = d > 1e-9 ? bv / d : vec2(0.0, 1.0);
  return d;
}

// Signed distance to one art primitive (negative inside), its gradient, and its height.
float primDist(int hdr, vec2 p, out vec2 g, out float height, out int role) {
  vec4 h0 = dataAt(hdr);
  vec4 h1 = dataAt(hdr + 1);
  vec4 box = dataAt(hdr + 2);
  int kind = int(h0.x + 0.5);
  role = int(h0.y + 0.5);
  height = h1.z;
  if (kind == 2) {
    vec2 c = 0.5 * (box.xy + box.zw);
    float r = 0.5 * (box.z - box.x);
    vec2 v = p - c;
    float l = length(v);
    g = l > 1e-9 ? v / l : vec2(0.0, 1.0);
    return l - r;
  }
  int start = int(h0.z + 0.5);
  int n = int(h0.w + 0.5);
  float best = 1e9;
  vec2 bv = vec2(0.0, 1.0);
  float bt = 0.0;
  bool inside = false;
  int segs = kind == 0 ? n : n - 1;
  vec2 b = kind == 0 ? dataAt(start + n - 1).xy : dataAt(start).xy;
  for (int i = 0; i < MAX_PTS; i++) {
    if (i >= segs) break;
    vec2 a = dataAt(start + (kind == 0 ? i : i + 1)).xy;
    vec2 ab = a - b;
    vec2 pb = p - b;
    float hh = clamp(dot(pb, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    vec2 v = pb - ab * hh;
    float d = dot(v, v);
    if (d < best) { best = d; bv = v; bt = (float(i) + hh) / max(1.0, float(segs)); }
    if (kind == 0 && (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    b = a;
  }
  float d = sqrt(best);
  g = d > 1e-9 ? bv / d : vec2(0.0, 1.0);
  if (kind == 0) {
    if (inside) { g = -g; return -d; }
    return d;
  }
  return d - 0.5 * mix(h1.x, h1.y, bt);
}

void main() {
  vec2 f = gl_FragCoord.xy / u_bRes;   // lattice coordinates in the cell
  vec2 P = u_bL * f;                    // tile frame
  int hit = -1;
  vec2 local = vec2(0.0);
  ivec2 hd = ivec2(0);
  for (int k = 0; k < 4; k++) {
    if (k >= u_bCopies || hit >= 0) break;
    mat2 inv = mat2(u_bInv[k].xy, u_bInv[k].zw);
    ivec4 r = u_bRange[k];
    for (int di = -2; di <= 2; di++) {
      if (di < r.x || di > r.y || hit >= 0) continue;
      for (int dj = -2; dj <= 2; dj++) {
        if (dj < r.z || dj > r.w) continue;
        vec2 l = inv * (P - u_bL * vec2(float(di), float(dj))) + u_bOff[k].xy;
        if (any(lessThan(l, u_bBox.xy)) || any(greaterThan(l, u_bBox.zw))) continue;
        if (insideOutline(l)) { hit = k; local = l; hd = ivec2(di, dj); break; }
      }
    }
  }
  if (hit < 0) {
    // Exactly on an edge (or a bad tile): treat as outline.
    o0 = vec4(0.0, 0.0, 1.0, 0.0);
    o1 = vec4(1.0, 0.0, 1.0, 0.0);
    return;
  }
  mat2 inv = mat2(u_bInv[hit].xy, u_bInv[hit].zw);
  mat2 fwd = transpose(inv);            // copies are isometries: base frame → world directions

  vec2 dir;
  float d = outlineDist(local, dir);
  vec2 n = normalize(fwd * dir);        // dir runs from the nearest outline point to p: inward

  // Interior art, in painter's order: set A then set B, each eroded by its own amount.
  int role = 0;
  float dTop = 1e9;     // distance to the boundary of the primitive on top here
  float dAbove = 1e9;   // nearest primitive drawn above it that doesn't cover here
  vec2 gTop = vec2(0.0, 1.0);
  vec2 gAbove = vec2(0.0, 1.0);
  float hArt = 0.0;
  for (int s = 0; s < 2; s++) {
    ivec2 set = s == 0 ? u_bSetA : u_bSetB;
    float erode = s == 0 ? u_bErode.x : u_bErode.y;
    for (int i = 0; i < MAX_PRIMS; i++) {
      if (i >= set.y) break;
      int hdr = set.x + i * 3;
      vec4 box = dataAt(hdr + 2);
      // Skip primitives too far to cover here or to be the nearest edge.
      vec2 out2 = max(max(box.xy - local, local - box.zw), 0.0);
      if (length(out2) > min(dTop, dAbove) + 0.001) continue;
      vec2 g;
      float h;
      int rl;
      float sd = primDist(hdr, local, g, h, rl) + erode;
      if (sd < 0.0) {
        role = rl;
        dTop = -sd;
        gTop = -g;
        dAbove = 1e9;
        hArt = h;
      } else if (sd < dAbove) {
        dAbove = sd;
        gAbove = g;
      }
    }
  }
  float dArt = min(dTop, dAbove);
  vec2 gArt = normalize(fwd * (dTop < dAbove ? gTop : gAbove));

  // Relief hint: a dome over the body, plus the art's raised or carved parts.
  float height = u_bDome * (1.0 - pow(1.0 - min(d / 0.35, 1.0), 2.0)) + hArt;

  int id = hit * 25 + (hd.x + 2) * 5 + (hd.y + 2);
  o0 = vec4(d * u_bScale, n, height);
  o1 = vec4(min(dArt, 1.0) * u_bScale, gArt, float(id * 8 + role));
}
