// Tentacube creature: rim light (obsidian) and glowing bands along the tentacles (emissive).
uniform float uRim;
uniform vec3 uRimColor;
uniform float uBands;
uniform float uTime;
uniform float uSlick; // oil-slick thin-film sheen weight
varying float vTubeS; // 0..1 along a tentacle; -1 on the cube
