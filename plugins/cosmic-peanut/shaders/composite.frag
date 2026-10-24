#version 300 es
// Cinematic look, last pass onto the transparent, premultiplied canvas (src/lib/look.js):
// - chromatic aberration: red sampled a little outward and blue inward, growing toward the corners;
// - bloom: an energy-conserving lerp toward the bloom chain's mean (mip 0 ÷ levels, tent-upsampled;
//   Jimenez 2014), so light is spread, never added;
// - exposure, Narkowicz's ACES fit, display encode (gamma 1 / 2.2; src/lib/look.js);
// - a gentle vignette and fine film grain, both multiplicative so empty pixels stay empty;
// - alpha = max(r, g, b): the image composites as light over the desktop, as in the classic look.
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uBloom;
uniform vec2 uBloomTexel;      // mip 0 texel size
uniform vec2 uAberration;      // red/blue offset at the corners, in uv
uniform float uBloomNorm, uBloomMix, uExposure, uVignette, uGrain, uSeed, uInvScale;
out vec4 o;

vec3 toDisplay(vec3 x) {
  return pow(x, vec3(1.0 / 2.2));
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// A cheap integer hash of the pixel and the grain seed (Mark Jarzynski & Marc Olano, "Hash
// Functions for GPU Rendering", JCGT 2020: PCG3D), to [-1, 1).
float grain(vec2 p) {
  uvec3 v = uvec3(uvec2(p), uint(uSeed));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return float(v.x >> 8u) / 8388608.0 - 1.0;
}

vec3 bloomAt(vec2 uv) {
  vec2 t = uBloomTexel;
  vec3 s = texture(uBloom, uv).rgb * 4.0;
  s += (texture(uBloom, uv + vec2(-t.x, 0.0)).rgb + texture(uBloom, uv + vec2(t.x, 0.0)).rgb
      + texture(uBloom, uv + vec2(0.0, -t.y)).rgb + texture(uBloom, uv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(uBloom, uv - t).rgb + texture(uBloom, uv + t).rgb
     + texture(uBloom, uv + vec2(t.x, -t.y)).rgb + texture(uBloom, uv + vec2(-t.x, t.y)).rgb;
  return s / 16.0;
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d) * 2.0;                               // 0 centre .. 1 corners
  vec2 off = d * 2.0 * r2 * uAberration;
  vec3 scene = vec3(texture(uScene, vUv + off).r, texture(uScene, vUv).g, texture(uScene, vUv - off).b);
  vec3 bloom = bloomAt(vUv) * uBloomNorm;
  vec3 hdr = mix(scene, bloom, uBloomMix) * uInvScale * uExposure;
  vec3 c = toDisplay(aces(hdr));
  c *= 1.0 - uVignette * smoothstep(0.15, 1.0, r2);
  c *= 1.0 + uGrain * grain(gl_FragCoord.xy);
  c = clamp(c, 0.0, 1.0);
  o = vec4(c, max(c.r, max(c.g, c.b)));
}
