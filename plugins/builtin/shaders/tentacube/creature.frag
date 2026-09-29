  // --- tentacube: rim + emissive bands (after aomap_fragment) ---
  float cFres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
  totalEmissiveRadiance += uRimColor * (cFres * uRim);
  // Oil slick: a thin-film rainbow that shifts with the viewing angle and along the body, on top
  // of three's iridescence (which alone reads mostly as the environment's colour here).
  if (uSlick > 0.0) {
    float cN = saturate(dot(normal, normalize(vViewPosition)));
    float cPh = cN * 2.2 + max(vTubeS, 0.0) * 1.5 + uTime * 0.05;
    vec3 cFilm = 0.5 + 0.5 * cos(6.2831853 * (cPh + vec3(0.0, 0.33, 0.67)));
    totalEmissiveRadiance += cFilm * cFilm * (0.18 + 0.5 * cFres) * uSlick;
  }
  if (vTubeS >= 0.0) {
    float cBand = 0.5 + 0.5 * sin(vTubeS * 26.0 - uTime * 5.0);
    totalEmissiveRadiance *= mix(1.0, 0.25 + 1.5 * cBand * cBand, uBands);
  }
  // --- end tentacube ---
