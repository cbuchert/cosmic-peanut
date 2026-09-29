// Tentacle tube: every vertex is placed from the chain's nodes (a data texture, one row per
// chain for positions, normals and binormals — rotation-minimizing frames from the CPU).
uniform highp sampler2D uNodes; // nodes × (chains × 3), RGBA32F
uniform float uNodeCount;
uniform float uRadius;          // root radius (world units)
uniform float uBulge;           // phase of the swelling that travels root → tip
uniform float uBulgeAmp;
attribute vec3 aTube;           // chain index, s = 0 (root) .. 1 (tip), angle around the tube
varying float vTubeS;

vec3 tubeNode(int j, int chain, int row) {
  return texelFetch(uNodes, ivec2(j, chain * 3 + row), 0).xyz;
}
