// Tetraballs surface pass (full resolution): the backdrop, and the blob sphere-traced inside its
// bounding sphere and shaded with material A, crossfading to B by u_mix. Output: premultiplied,
// tone-mapped colour with alpha = coverage (1 everywhere with the studio backdrop).
uniform int u_matA;
uniform int u_matB;
uniform float u_mix;

out vec4 o;

void main() {
  vec3 ro = vec3(0.0, 0.0, CAM);
  vec3 rd = rayDir(gl_FragCoord.xy);
  vec4 col = vec4(0.0);
  vec2 tb = sphereHit(ro, rd, u_bound);
  if (tb.x < tb.y && u_fade > 0.0) {
    float t = march(ro, rd, tb.x, tb.y);
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 n = calcNormal(p);
      vec4 a = shade(u_matA, p, n, rd);
      if (u_mix > 0.0) a = mix(a, shade(u_matB, p, n, rd), u_mix);
      col = a * u_fade;
      col.rgb *= u_light;
    }
  }
  vec3 lin = col.rgb + backdrop(gl_FragCoord.xy) * u_bgA * (1.0 - col.a);
  float alpha = col.a + u_bgA * (1.0 - col.a);
  o = alpha > 1e-4 ? vec4(tonemap(lin / alpha) * alpha, alpha) : vec4(0.0);
}
